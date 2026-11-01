use ascent_proto::discovery::{find_devices, is_candidate, FoundDevice};
use ascent_proto::serial::SerialConnector;
use ascent_proto::sim::{SimConnector, SimDevice};
use ascent_proto::{AckTiming, Connector, PortInfo};
use clap::{Parser, Subcommand};
use std::process::ExitCode;

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
