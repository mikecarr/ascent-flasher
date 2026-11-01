use ascent_proto::sim::{SimConnector, SimDevice};
use ascent_proto::*;
use std::time::{Duration, Instant};

const TIMING: AckTiming = AckTiming {
    resend_every: Duration::from_millis(20),
    give_up_after: Duration::from_millis(100),
};

fn setup(dev: SimDevice) -> (SimConnector, Session) {
    let c = SimConnector::new("/dev/sim0", 0x1234, 0x5678, dev);
    let link = c.open("/dev/sim0").unwrap();
    (c, Session::new(link, TIMING))
}

#[test]
fn find_device_roundtrip() {
    let (c, mut s) = setup(SimDevice::lite_plus());
    let info = s.find_device().unwrap();
    assert_eq!(info, c.device.lock().unwrap().info);
    assert_eq!(info.device_name, "ascent_lite_plus");
    let log = c.device.lock().unwrap().log.clone();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].command, 60);
    assert_eq!(log[0].retry, 0);
}

#[test]
fn resends_same_seq_with_retry() {
    let mut d = SimDevice::lite_plus();
    d.drop_first_requests = 1;
    let (c, mut s) = setup(d);
    s.request(Command::FindDevice, &[]).unwrap();
    let log = c.device.lock().unwrap().log.clone();
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].seq, log[1].seq);
    assert_eq!((log[0].retry, log[1].retry), (0, 1));
}

#[test]
fn times_out() {
    let mut d = SimDevice::lite_plus();
    d.drop_first_requests = 100;
    let (_c, mut s) = setup(d);
    let t = Instant::now();
    let r = s.request(Command::FindDevice, &[]);
    assert!(matches!(
        r,
        Err(SessionError::Timeout {
            cmd: Command::FindDevice
        })
    ));
    assert!(t.elapsed() <= Duration::from_millis(300));
}

#[test]
fn seq_increments_per_request() {
    let (c, mut s) = setup(SimDevice::lite_plus());
    s.request(Command::FindDevice, &[]).unwrap();
    s.request(Command::FindDevice, &[]).unwrap();
    let log = c.device.lock().unwrap().log.clone();
    assert_eq!(log[1].seq, log[0].seq + 1);
}

#[test]
fn file_transfer_and_status() {
    let (c, mut s) = setup(SimDevice::lite_plus());
    s.request(Command::SendFileStart, &file_info("ab", 5, "/r", "l"))
        .unwrap();
    let f = s.request(Command::SendFileData, b"abc").unwrap();
    let i = FileDataInfo::decode(&f.payload).unwrap();
    assert_eq!((i.length, i.cursize, i.status), (3, 3, 0));
    s.request(Command::SendFileData, b"de").unwrap();
    let f = s.request(Command::SendFileEnd, &[]).unwrap();
    assert_eq!(FileDataInfo::decode(&f.payload).unwrap().detail, "OK");
    assert_eq!(c.device.lock().unwrap().received_file, b"abcde");
    assert_eq!(c.device.lock().unwrap().received_requests[0].1.len(), 328);
    let f = s.request(Command::UpgradeStatus, &[]).unwrap();
    assert_eq!(UpgradeStatus::decode(&f.payload).unwrap().percent, 100);
}

#[test]
fn reboot_takes_device_offline_then_back_moved() {
    let mut d = SimDevice::lite_plus();
    d.reboot_moves_to = Some("/dev/sim1".into());
    d.offline_for = Duration::from_millis(60);
    let (c, mut s) = setup(d);
    s.send_no_ack(Command::Reboot, &reboot_mode("clean"))
        .unwrap();
    assert!(c.list().unwrap().is_empty());
    assert!(matches!(
        s.find_device(),
        Err(SessionError::Io(e)) if e.kind() == std::io::ErrorKind::BrokenPipe
    ));
    assert_eq!(c.device.lock().unwrap().reboot_modes, vec!["clean"]);
    std::thread::sleep(Duration::from_millis(80));
    let l = c.list().unwrap();
    assert_eq!(l.len(), 1);
    assert_eq!(l[0].path, "/dev/sim1");
    assert_eq!((l[0].vid, l[0].pid), (0x1234, 0x5678));
    assert!(c.open("/dev/sim1").is_ok());
}

#[test]
fn unplug_after_chunks() {
    let mut d = SimDevice::lite_plus();
    d.unplug_after_data_chunks = Some(1);
    let (c, mut s) = setup(d);
    s.request(Command::SendFileData, b"x").unwrap();
    assert!(matches!(
        s.request(Command::SendFileData, b"y"),
        Err(SessionError::Io(_))
    ));
    assert!(c.list().unwrap().is_empty());
}

#[test]
fn status_100_self_reboots() {
    let mut d = SimDevice::lite_plus();
    d.offline_for = Duration::from_millis(50);
    let (c, mut s) = setup(d);
    s.request(Command::UpgradeStatus, &[]).unwrap();
    assert!(c.list().unwrap().is_empty());
    std::thread::sleep(Duration::from_millis(70));
    assert_eq!(c.list().unwrap().len(), 1);
}
