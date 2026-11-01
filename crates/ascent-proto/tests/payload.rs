use ascent_proto::payload::*;
use ascent_proto::Command;

fn put_str(b: &mut [u8], off: usize, s: &str) {
    b[off..off + s.len()].copy_from_slice(s.as_bytes());
}

fn put_i32(b: &mut [u8], off: usize, v: i32) {
    b[off..off + 4].copy_from_slice(&v.to_le_bytes());
}

#[test]
fn command_ids() {
    assert_eq!(Command::FindDevice as u32, 60);
    assert_eq!(Command::UpgradeStatus.id(), 118);
}

#[test]
fn device_info_decodes_offsets() {
    let mut b = vec![0u8; 300];
    put_i32(&mut b, 0, 4096);
    put_str(&mut b, 4, "1.0.0");
    put_str(&mut b, 36, "ascent_lite_plus");
    put_i32(&mut b, 100, 42);
    put_str(&mut b, 104, "Ascent_Lite_Plus_1_2_3");
    put_str(&mut b, 168, "SN123");
    put_str(&mut b, 200, "V1.0");
    put_i32(&mut b, 232, 0);
    put_str(&mut b, 236, "OK");
    let d = DeviceInfo::decode(&b).unwrap();
    assert_eq!(
        d,
        DeviceInfo {
            receive_max_size: 4096,
            sdk_version: "1.0.0".into(),
            device_name: "ascent_lite_plus".into(),
            cpu_temp: 42,
            firmware: "Ascent_Lite_Plus_1_2_3".into(),
            serial_number: "SN123".into(),
            hardware_version: "V1.0".into(),
            status: 0,
            detail: "OK".into(),
        }
    );
}

#[test]
fn device_info_too_short() {
    assert_eq!(
        DeviceInfo::decode(&[0; 10]),
        Err(PayloadError::TooShort { need: 300, got: 10 })
    );
}

#[test]
fn file_info_layout() {
    let md5 = "d41d8cd98f00b204e9800998ecf8427e";
    let b = file_info(md5, 5, "/tmp/pc/a.img", "/Users/x/a.img");
    assert_eq!(b.len(), 328);
    assert_eq!(&b[..32], md5.as_bytes());
    assert_eq!(b[32], 0);
    assert_eq!(b[64..68], 5u32.to_le_bytes());
    assert_eq!(b[68..72], 1u32.to_le_bytes());
    assert_eq!(&b[72..72 + 13], b"/tmp/pc/a.img");
    assert_eq!(b[72 + 13], 0);
    assert_eq!(&b[200..200 + 14], b"/Users/x/a.img");
    assert_eq!(b[200 + 14], 0);
}

#[test]
fn file_info_truncates_long_local_path() {
    let local: String = (0..300)
        .map(|i| char::from(b'a' + (i % 26) as u8))
        .collect();
    let b = file_info("x", 1, "/tmp/pc/a.img", &local);
    assert_eq!(&b[200..328], &local.as_bytes()[300 - 128..]);
}

#[test]
fn reboot_mode_pads() {
    let m = reboot_mode("clean");
    assert_eq!(m[..5], *b"clean");
    assert!(m[5..].iter().all(|&x| x == 0));
}

#[test]
fn status_messages_cover_codes() {
    for code in -12..=-1 {
        let m = status_message(code);
        assert_ne!(m, "Upgrade failed (unknown error)", "code {code}");
        assert!(!m.is_empty());
    }
    assert_eq!(
        status_message(-5),
        "Wrong model: this firmware is for a different device"
    );
    assert_eq!(
        status_message(-6),
        "Firmware version is too old for this device"
    );
    assert_eq!(status_message(-9), "Firmware image CRC error");
    assert_eq!(status_message(-99), "Upgrade failed (unknown error)");
}

#[test]
fn file_data_info_decodes() {
    let mut b = vec![0u8; 80];
    put_i32(&mut b, 0, 1);
    put_i32(&mut b, 4, 2);
    put_i32(&mut b, 8, 3);
    put_i32(&mut b, 12, 0);
    put_str(&mut b, 16, "OK");
    let f = FileDataInfo::decode(&b).unwrap();
    assert_eq!((f.length, f.cursize, f.totalsize, f.status), (1, 2, 3, 0));
    assert_eq!(f.detail, "OK");
    assert_eq!(
        FileDataInfo::decode(&b[..5]),
        Err(PayloadError::TooShort { need: 80, got: 5 })
    );
}

#[test]
fn upgrade_status_decodes() {
    let mut b = vec![0u8; 72];
    put_i32(&mut b, 0, 50);
    put_i32(&mut b, 4, -9);
    put_str(&mut b, 8, "bad");
    let u = UpgradeStatus::decode(&b).unwrap();
    assert_eq!((u.percent, u.status, u.detail.as_str()), (50, -9, "bad"));
    assert_eq!(
        UpgradeStatus::decode(&b[..71]),
        Err(PayloadError::TooShort { need: 72, got: 71 })
    );
}

#[test]
fn device_info_roundtrip() {
    let d = DeviceInfo {
        receive_max_size: 1_048_576,
        sdk_version: "2.0".into(),
        device_name: "ascent".into(),
        cpu_temp: -3,
        firmware: "fw".into(),
        serial_number: "SN".into(),
        hardware_version: "hw".into(),
        status: 0,
        detail: "OK".into(),
    };
    let b = d.encode();
    assert_eq!(b.len(), 300);
    assert_eq!(DeviceInfo::decode(&b).unwrap(), d);
    let long = DeviceInfo {
        sdk_version: "x".repeat(50),
        ..d
    };
    let r = DeviceInfo::decode(&long.encode()).unwrap();
    assert_eq!(r.sdk_version.len(), 32);
}

#[test]
fn file_data_info_roundtrip() {
    let f = FileDataInfo {
        length: 10,
        cursize: 20,
        totalsize: 30,
        status: -1,
        detail: "err".into(),
    };
    let b = f.encode();
    assert_eq!(b.len(), 80);
    assert_eq!(FileDataInfo::decode(&b).unwrap(), f);
}

#[test]
fn upgrade_status_roundtrip() {
    let u = UpgradeStatus {
        percent: 100,
        status: 3,
        detail: "DONE".into(),
    };
    let b = u.encode();
    assert_eq!(b.len(), 72);
    assert_eq!(UpgradeStatus::decode(&b).unwrap(), u);
}
