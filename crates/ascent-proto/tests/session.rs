use ascent_proto::frame::encode_ack;
use ascent_proto::sim::{SimConnector, SimDevice};
use ascent_proto::*;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
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

type ReplyFn = Box<dyn FnMut(&Header) -> Vec<Vec<u8>> + Send>;

/// Link that parses requests and replies via a closure producing ack bytes.
struct FakeLink {
    reader: FrameReader,
    rx: VecDeque<u8>,
    seen: Arc<Mutex<Vec<u32>>>,
    reply: ReplyFn,
}

impl Link for FakeLink {
    fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        self.reader.push(buf);
        while let Some(f) = self.reader.next_frame() {
            self.seen.lock().unwrap().push(f.header.seq);
            for r in (self.reply)(&f.header) {
                self.rx.extend(r);
            }
        }
        Ok(())
    }
    fn read_some(&mut self, buf: &mut [u8], timeout: Duration) -> std::io::Result<usize> {
        if self.rx.is_empty() {
            std::thread::sleep(timeout);
        }
        let n = buf.len().min(self.rx.len());
        for b in buf.iter_mut().take(n) {
            *b = self.rx.pop_front().unwrap();
        }
        Ok(n)
    }
}

fn fake(reply: impl FnMut(&Header) -> Vec<Vec<u8>> + Send + 'static) -> Session {
    Session::new(
        Box::new(FakeLink {
            reader: FrameReader::new(),
            rx: VecDeque::new(),
            seen: Arc::default(),
            reply: Box::new(reply),
        }),
        TIMING,
    )
}

#[test]
fn stale_duplicate_ack_is_skipped() {
    let mut n = 0;
    let mut s = fake(move |h| {
        n += 1;
        // Distinguish replies by payload; first request is acked twice.
        let a = encode_ack(h.command, &[n], h.seq);
        if n == 1 {
            vec![a.clone(), a]
        } else {
            vec![a]
        }
    });
    let a = s.request(Command::SendFileData, b"a").unwrap();
    assert_eq!(a.header.seq, 1);
    let b = s.request(Command::SendFileData, b"b").unwrap();
    assert_eq!(b.header.seq, 2);
    assert_eq!(b.payload, vec![2]);
    assert_eq!(s.echoes_seq(), Some(true));
}

#[test]
fn stale_ack_with_old_seq_is_skipped_once_echo_learned() {
    let mut n = 0;
    let mut s = fake(move |h| {
        n += 1;
        if n == 2 {
            // Late ack for seq 1 arrives ahead of B's own reply.
            vec![
                encode_ack(h.command, &[9], h.seq - 1),
                encode_ack(h.command, &[2], h.seq),
            ]
        } else {
            vec![encode_ack(h.command, &[n], h.seq)]
        }
    });
    s.request(Command::SendFileData, b"a").unwrap();
    let b = s.request(Command::SendFileData, b"b").unwrap();
    assert_eq!(b.payload, vec![2]);
}

#[test]
fn command_only_when_device_does_not_echo_seq() {
    let mut s = fake(|h| vec![encode_ack(h.command, &[], 0)]);
    s.request(Command::FindDevice, &[]).unwrap();
    s.request(Command::FindDevice, &[]).unwrap();
    assert_eq!(s.echoes_seq(), Some(false));
}

#[test]
fn seq_starts_at_one() {
    let (c, mut s) = setup(SimDevice::lite_plus());
    assert_eq!(s.echoes_seq(), None);
    s.request(Command::FindDevice, &[]).unwrap();
    assert_eq!(c.device.lock().unwrap().log[0].seq, 1);
}
