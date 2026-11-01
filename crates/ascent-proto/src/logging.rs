//! Shared logging setup: stderr (WARN, or DEBUG with --debug) plus one INFO log file per run.

use std::path::PathBuf;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer};

fn log_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library/Logs/AscentFlasher")
    } else {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("AscentFlasher/logs")
    }
}

/// Install the global subscriber. Keep the returned guard alive until exit.
pub fn init(debug: bool) -> WorkerGuard {
    let dir = log_dir();
    let name = format!("{}.log", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let _ = std::fs::create_dir_all(&dir);
    let appender = tracing_appender::rolling::never(&dir, &name);
    let (file, guard) = tracing_appender::non_blocking(appender);

    let file_filter = EnvFilter::new(if debug {
        "info,ascent_proto=trace"
    } else {
        "info"
    });
    let stderr_filter = EnvFilter::new(if debug {
        "debug,ascent_proto=debug"
    } else {
        "warn"
    });

    tracing_subscriber::registry()
        .with(
            fmt::layer()
                .with_writer(file)
                .with_ansi(false)
                .with_filter(file_filter),
        )
        .with(
            fmt::layer()
                .with_writer(std::io::stderr)
                .with_filter(stderr_filter),
        )
        .init();
    eprintln!("log file: {}", dir.join(&name).display());
    guard
}
