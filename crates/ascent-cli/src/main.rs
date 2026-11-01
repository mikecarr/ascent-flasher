use ascent_proto::discovery::{find_devices, is_candidate, FoundDevice};
use ascent_proto::firmware::{device_version, preflight, PreflightError, Warning};
use ascent_proto::serial::SerialConnector;
use ascent_proto::sim::{SimConnector, SimDevice};
use ascent_proto::upgrade::{
    progress_text, run_upgrade, CancelToken, Progress, UpgradeError, UpgradeOptions,
};
use ascent_proto::{AckTiming, Connector, PortInfo};
use clap::{Parser, Subcommand};
use std::io::{BufRead, IsTerminal, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Parser)]
#[command(
    name = "ascent-flash",
    version,
    about = "Caddx Ascent flasher (unofficial)"
)]
struct Cli {
    /// Trace-level logging (hex dumps)
    #[arg(long, global = true)]
    debug: bool,
    /// Use a simulated Ascent Lite+ instead of real hardware
    #[arg(long, global = true)]
    simulate: bool,
    #[command(subcommand)]
    command: Cmd,
    /// Testing aid for --simulate: slow the simulated send so Ctrl-C can be tried
    #[arg(long, global = true, hide = true)]
    sim_slow: bool,
}

#[derive(Subcommand)]
enum Cmd {
    /// List candidate serial ports
    List,
    /// Query device info (read-only FIND_DEVICE)
    Info {
        /// Serial port path (default: all candidates)
        #[arg(long)]
        port: Option<String>,
    },
    /// Flash a firmware .img file
    Flash {
        /// Firmware file (.img)
        file: PathBuf,
        /// Serial port path (default: the single flashable device)
        #[arg(long)]
        port: Option<String>,
        /// Skip all questions (warnings and final confirmation)
        #[arg(long, short = 'y')]
        yes: bool,
    },
}

fn candidates(conn: &dyn Connector) -> std::io::Result<Vec<PortInfo>> {
    Ok(conn
        .list()?
        .into_iter()
        .filter(|p| is_candidate(p.vid))
        .collect())
}

fn print_device(f: &FoundDevice) {
    let i = &f.info;
    println!("port: {}", f.port.path);
    println!("vid_pid: {:04X}:{:04X}", f.port.vid, f.port.pid);
    println!("usb_serial: {}", f.port.serial.as_deref().unwrap_or("-"));
    println!("device_name: {}", i.device_name);
    println!("firmware: {}", i.firmware);
    println!("hardware_version: {}", i.hardware_version);
    println!("sdk_version: {}", i.sdk_version);
    println!("serial_number: {}", i.serial_number);
    println!("receive_max_size: {}", i.receive_max_size);
    println!("cpu_temp: {}", i.cpu_temp);
    println!("status: {}", i.status);
    println!("detail: {}", i.detail);
    let echo = match f.echoes_seq {
        Some(true) => "yes",
        Some(false) => "no",
        None => "unknown",
    };
    println!("echoes_seq: {echo}");
    println!("flashable: {}", if f.is_flashable() { "yes" } else { "no" });
}

/// Ask a y/N question on stdin; anything but y/yes (or EOF) is No.
fn confirm(question: &str) -> bool {
    print!("{question} [y/N] ");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    match std::io::stdin().lock().read_line(&mut line) {
        Ok(n) if n > 0 => matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes"),
        _ => false,
    }
}

fn warning_question(w: &Warning) -> String {
    match w {
        Warning::Downgrade { from, to } => format!(
            "The file ({to}) is older than the device ({from}). Downgrading usually fails. Continue?"
        ),
        Warning::NameMismatch { expected } => format!(
            "This file name doesn't look like firmware for this device (expected '{expected}' in the name). Continue?"
        ),
        Warning::UnknownVersion => {
            "Couldn't read a version from the file name. Continue?".to_string()
        }
    }
}

/// Prints progress: one line per change; `\r` updates for percentages on a TTY.
struct ProgressPrinter {
    tty: bool,
    in_percent_line: bool,
    last: String,
    last_bucket: Option<u64>,
}

impl ProgressPrinter {
    fn new() -> Self {
        ProgressPrinter {
            tty: std::io::stdout().is_terminal(),
            in_percent_line: false,
            last: String::new(),
            last_bucket: None,
        }
    }

    fn show(&mut self, p: &Progress) {
        let Some(text) = progress_text(p) else { return };
        if text == self.last {
            return;
        }
        let percent = match p {
            Progress::Sent { bytes, total } if *total > 0 => Some(bytes * 100 / total),
            Progress::Writing { percent } => Some(u64::from(*percent)),
            _ => None,
        };
        if self.tty {
            if percent.is_some() {
                print!("\r{text}   ");
                self.in_percent_line = true;
            } else {
                if self.in_percent_line {
                    println!();
                    self.in_percent_line = false;
                }
                println!("{text}");
            }
        } else if let Some(pc) = percent {
            // Plain output: a line per 10% (and the last one), not per chunk.
            let bucket = pc / 10;
            if self.last_bucket == Some(bucket) && pc < 100 {
                return;
            }
            self.last_bucket = Some(bucket);
            println!("{text}");
        } else {
            self.last_bucket = None;
            println!("{text}");
        }
        let _ = std::io::stdout().flush();
        self.last = text;
    }

    fn finish_line(&mut self) {
        if self.in_percent_line {
            println!();
            self.in_percent_line = false;
        }
    }
}

fn print_error(e: &UpgradeError) {
    eprintln!("Error: {e}");
    if let Some(h) = e.recovery_hint() {
        eprintln!("{h}");
    }
}

fn flash(
    conn: &dyn Connector,
    cli: &Cli,
    file: &std::path::Path,
    port: &Option<String>,
    yes: bool,
) -> Result<u8, String> {
    let mut found = Vec::new();
    for r in find_devices(conn, AckTiming::default()) {
        match r {
            Ok(f) => found.push(f),
            Err((p, e)) => eprintln!("{}: {e}", p.path),
        }
    }
    if let Some(want) = port {
        found.retain(|f| &f.port.path == want);
    }
    let flashable: Vec<&FoundDevice> = found.iter().filter(|f| f.is_flashable()).collect();
    let device = match (flashable.len(), found.len()) {
        (1, _) => flashable[0],
        // A single non-flashable device: let preflight explain why.
        (0, 1) => &found[0],
        (0, 0) => {
            println!("No flashable Ascent device found. Plug in the VTX via USB.");
            return Ok(2);
        }
        (0, _) => {
            println!("No flashable Ascent device found. Devices seen:");
            for f in &found {
                println!(
                    "  {}  {:04X}:{:04X}  {}",
                    f.port.path, f.port.vid, f.port.pid, f.info.device_name
                );
            }
            return Ok(2);
        }
        _ => {
            println!("More than one flashable device found; choose one with --port:");
            for f in &flashable {
                println!(
                    "  {}  {}  {}",
                    f.port.path, f.info.device_name, f.info.firmware
                );
            }
            return Ok(2);
        }
    };

    let (fw, warnings) = match preflight(&device.info, file) {
        Ok(x) => x,
        Err(PreflightError::NotFlashable(name)) => {
            eprintln!("This device ({name}) can't be flashed by this tool.");
            return Ok(1);
        }
        Err(e) => {
            eprintln!("{e}");
            return Ok(1);
        }
    };

    let dev_ver = device_version(&device.info.firmware);
    let show = |v: &Option<ascent_proto::firmware::FwVersion>| {
        v.as_ref().map_or("unknown".to_string(), |v| v.to_string())
    };
    println!(
        "Device: {} on {}",
        device.info.device_name, device.port.path
    );
    println!("Device version: {}", show(&dev_ver));
    println!("File: {}", file.display());
    println!("File version: {}", show(&fw.version));

    for w in &warnings {
        let q = warning_question(w);
        if yes {
            println!("Warning: {q}");
        } else if !confirm(&q) {
            println!("Aborted.");
            return Ok(1);
        }
    }
    if !yes && !confirm("Keep USB connected and the VTX powered. Flash now?") {
        println!("Aborted.");
        return Ok(1);
    }

    let mut opts = UpgradeOptions::for_port(&device.port);
    if cli.simulate {
        opts.reopen_delay = Duration::from_millis(50);
        opts.status_poll = Duration::from_millis(50);
    }

    let cancel = CancelToken::new();
    let locked = Arc::new(AtomicBool::new(false));
    {
        // Set once; the handler never exits the process, so recovery can finish.
        let (cancel, locked) = (cancel.clone(), locked.clone());
        let installed = ctrlc::set_handler(move || {
            if locked.load(Ordering::SeqCst) {
                eprintln!("\nDevice is writing firmware — do not unplug (Ctrl-C is ignored now)");
            } else {
                cancel.cancel();
                eprintln!("\nCancelling…");
            }
        });
        if let Err(e) = installed {
            eprintln!("Error: couldn't install the Ctrl-C handler: {e}");
            return Ok(1);
        }
    }

    let mut printer = ProgressPrinter::new();
    let slow = cli.simulate && cli.sim_slow;
    let result = run_upgrade(conn, &device.port, &fw, &opts, &cancel, &mut |p| {
        if matches!(p, Progress::CancelLocked) {
            locked.store(true, Ordering::SeqCst);
        }
        printer.show(&p);
        if slow && matches!(p, Progress::Sent { .. }) {
            std::thread::sleep(Duration::from_millis(400));
        }
    });
    printer.finish_line();

    match result {
        Ok(outcome) => {
            let new_ver = device_version(&outcome.info.firmware);
            println!("Done — now on {}", show(&new_ver));
            if let (Some(n), Some(f)) = (&new_ver, &fw.version) {
                if n != f {
                    println!("Warning: device reports {n} but the file was {f}");
                }
            }
            Ok(0)
        }
        Err(e) => {
            print_error(&e);
            Ok(1)
        }
    }
}

fn run(cli: &Cli) -> Result<u8, String> {
    let conn: Box<dyn Connector> = if cli.simulate {
        Box::new(SimConnector::new(
            "/dev/cu.usbmodemSIM1",
            0x1D6B,
            0x0104,
            SimDevice::lite_plus(),
        ))
    } else {
        Box::new(SerialConnector)
    };
    match &cli.command {
        Cmd::Flash { file, port, yes } => flash(conn.as_ref(), cli, file, port, *yes),
        Cmd::List => {
            let ports = candidates(conn.as_ref()).map_err(|e| e.to_string())?;
            if ports.is_empty() {
                println!("No candidate ports found.");
                return Ok(2);
            }
            for p in ports {
                println!(
                    "{}  {:04X}:{:04X}  {}",
                    p.path,
                    p.vid,
                    p.pid,
                    p.serial.as_deref().unwrap_or("-")
                );
            }
            Ok(0)
        }
        Cmd::Info { port } => {
            let results = find_devices(conn.as_ref(), AckTiming::default());
            let mut ok = Vec::new();
            let mut failed = false;
            for r in results {
                match r {
                    Ok(f) => ok.push(f),
                    Err((p, e)) => {
                        eprintln!("{}: {e}", p.path);
                        failed = true;
                    }
                }
            }
            if let Some(want) = port {
                ok.retain(|f| &f.port.path == want);
                if ok.is_empty() {
                    eprintln!("{want}: no Ascent device responded on this port");
                    return Ok(if failed { 1 } else { 2 });
                }
            }
            if ok.is_empty() {
                if failed {
                    return Ok(1);
                }
                println!("No Ascent device found. Plug in the VTX via USB.");
                return Ok(2);
            }
            for (n, f) in ok.iter().enumerate() {
                if n > 0 {
                    println!();
                }
                print_device(f);
            }
            Ok(if failed { 1 } else { 0 })
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let _guard = ascent_proto::logging::init(cli.debug);
    match run(&cli) {
        Ok(code) => ExitCode::from(code),
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(1)
        }
    }
}
