use ascent_proto::firmware::{
    device_version, file_version, name_matches, preflight, FwVersion, PreflightError, Warning,
};
use ascent_proto::DeviceInfo;
use std::path::Path;

fn v(major: u32, minor: u32, patch: u32) -> FwVersion {
    FwVersion {
        major,
        minor,
        patch,
        extra: None,
    }
}

fn info(name: &str, fw: &str) -> DeviceInfo {
    DeviceInfo {
        receive_max_size: 4096,
        sdk_version: String::new(),
        device_name: name.into(),
        cpu_temp: 0,
        firmware: fw.into(),
        serial_number: String::new(),
        hardware_version: String::new(),
        status: 0,
        detail: String::new(),
    }
}

fn write(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let p = dir.path().join(name);
    std::fs::write(&p, bytes).unwrap();
    p
}

const FW: &str = "Ascent_H_Sky_17_5_8";

#[test]
fn parses_file_versions() {
    assert_eq!(file_version("Ascent_Lite_Plus_1_3_0.img"), Some(v(1, 3, 0)));
    let e = file_version("x_16_4_4_z40_2.img").unwrap();
    assert_eq!(
        e,
        FwVersion {
            major: 16,
            minor: 4,
            patch: 4,
            extra: Some(2)
        }
    );
    assert_eq!(e.to_string(), "V16.4.4.2");
    assert_eq!(v(1, 3, 0).to_string(), "V1.3.0");
    assert_eq!(file_version("notes.txt"), None);
    assert_eq!(file_version("Ascent_H_Sky_17_6_0.IMG"), Some(v(17, 6, 0)));
}

#[test]
fn parses_device_version() {
    assert_eq!(device_version("Ascent_H_Sky_17_5_8"), Some(v(17, 5, 8)));
    assert_eq!(device_version("Ascent_Lite_Plus_1_2_3"), Some(v(1, 2, 3)));
    assert_eq!(device_version("garbage"), None);
}

#[test]
fn name_match_rules() {
    assert!(name_matches("Ascent_H_Sky_17_6_0.img", FW));
    assert!(name_matches("ascent-h-sky 17.6.0.img", FW));
    assert!(!name_matches("Ascent_Lite_Plus_17_6_0.img", FW));
    assert!(!name_matches("Ascent_L_Sky_17_6_0.img", FW));
    assert!(!name_matches("Ascent_H_Sky_Pro_17_6_0.img", FW));

    assert!(name_matches(
        "Ascent_Lite_Plus_1_3_0.img",
        "Ascent_Lite_Plus_1_2_3"
    ));
    assert!(name_matches(
        "ascent-lite-plus 1.3.0.img",
        "Ascent_Lite_Plus_1_2_3"
    ));
    assert!(!name_matches(
        "Ascent_Lite_Plus_1_3_0.img",
        "Ascent_Lite_1_2_3"
    ));
    assert!(!name_matches(
        "Ascent_VRX_1_3_0.img",
        "Ascent_Lite_Plus_1_2_3"
    ));
    // Empty prefix: nothing to check.
    assert!(name_matches("Anything_1_3_0.img", "Ascent_1_2_3"));
}

#[test]
fn preflight_rejects() {
    let d = tempfile::tempdir().unwrap();
    let dev = info("Ascent_lite", FW);

    let missing = d.path().join("Ascent_H_Sky_17_6_0.img");
    assert!(matches!(
        preflight(&dev, &missing),
        Err(PreflightError::Unreadable(_))
    ));

    let empty = write(&d, "Ascent_H_Sky_17_6_1.img", b"");
    assert!(matches!(
        preflight(&dev, &empty),
        Err(PreflightError::Empty)
    ));

    let bin = write(&d, "fw.bin", b"x");
    assert!(matches!(preflight(&dev, &bin), Err(PreflightError::NotImg)));

    let long = "a".repeat(201);
    assert!(matches!(
        preflight(&dev, Path::new(&long)),
        Err(PreflightError::PathTooLong)
    ));

    let ok = write(&d, "Ascent_H_Sky_17_6_2.img", b"x");
    assert!(matches!(
        preflight(&info("ascent_vrx", FW), &ok),
        Err(PreflightError::NotFlashable(n)) if n == "ascent_vrx"
    ));

    let upper = write(&d, "Ascent_H_Sky_17_6_3.IMG", b"x");
    assert!(preflight(&dev, &upper).is_ok());
}

#[test]
fn preflight_warns_downgrade() {
    let d = tempfile::tempdir().unwrap();
    let p = write(&d, "Ascent_H_Sky_17_4_0.img", b"data");
    let (_, w) = preflight(&info("Ascent_lite", FW), &p).unwrap();
    assert_eq!(
        w,
        vec![Warning::Downgrade {
            from: v(17, 5, 8),
            to: v(17, 4, 0)
        }]
    );
}

#[test]
fn preflight_clean_upgrade() {
    let d = tempfile::tempdir().unwrap();
    let p = write(&d, "Ascent_H_Sky_17_6_0.img", b"data");
    let (fw, w) = preflight(&info("Ascent_lite", FW), &p).unwrap();
    assert!(w.is_empty());
    assert_eq!(fw.version, Some(v(17, 6, 0)));
    assert_eq!(fw.bytes, b"data");
}

#[test]
fn preflight_name_mismatch_warns() {
    let d = tempfile::tempdir().unwrap();
    let p = write(&d, "Ascent_Lite_Plus_17_6_0.img", b"data");
    let (_, w) = preflight(&info("Ascent_lite", FW), &p).unwrap();
    assert!(w.contains(&Warning::NameMismatch {
        expected: "H_Sky".into()
    }));
}

#[test]
fn preflight_unknown_version_warns() {
    let d = tempfile::tempdir().unwrap();
    let p = write(&d, "custom.img", b"data");
    let (fw, w) = preflight(&info("Ascent_lite", FW), &p).unwrap();
    assert_eq!(fw.version, None);
    assert!(w.contains(&Warning::UnknownVersion));
}

#[test]
fn preflight_md5() {
    let d = tempfile::tempdir().unwrap();
    let p = write(&d, "Ascent_H_Sky_17_6_0.img", b"abc");
    let (fw, _) = preflight(&info("Ascent_lite", FW), &p).unwrap();
    assert_eq!(fw.md5_hex, "900150983cd24fb0d6963f7d28e17f72");
}

#[test]
fn preflight_rejects_oversize() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("Ascent_H_Sky_17_6_0.img");
    let f = std::fs::File::create(&p).unwrap();
    // Sparse: takes no disk space, and preflight must not read it.
    f.set_len(256 * 1024 * 1024 + 1).unwrap();
    drop(f);
    let r = preflight(&info("Ascent_lite", FW), &p);
    match r {
        Err(e @ PreflightError::TooLarge { size }) => {
            assert_eq!(size, 256 * 1024 * 1024 + 1);
            assert_eq!(
                e.to_string(),
                "firmware file is too large (268 MB) — Ascent images are at most about 180 MB; is this the right file?"
            );
        }
        other => panic!("unexpected {other:?}"),
    }
    // Exactly 256 MiB is accepted.
    let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
    f.set_len(256 * 1024 * 1024).unwrap();
    drop(f);
    assert!(preflight(&info("Ascent_lite", FW), &p).is_ok());
}

#[test]
fn preflight_rejects_long_file_name() {
    let d = tempfile::tempdir().unwrap();
    let dev = info("Ascent_lite", FW);
    // "/tmp/pc/" (8) + 119 = 127 bytes: fits with the NUL.
    let ok_name = format!("{}_17_6_0.img", "A".repeat(119 - 11));
    assert_eq!(ok_name.len(), 119);
    let ok = write(&d, &ok_name, b"x");
    assert!(preflight(&dev, &ok).is_ok());
    // One byte more: 128 bytes, no room for the NUL.
    let long_name = format!("{}_17_6_0.img", "A".repeat(120 - 11));
    let long = write(&d, &long_name, b"x");
    match preflight(&dev, &long) {
        Err(e @ PreflightError::BadFileName) => assert_eq!(
            e.to_string(),
            "rename the file to a shorter ASCII name, e.g. Ascent_H_Sky_18_21_10.img"
        ),
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn preflight_rejects_non_ascii_file_name() {
    let d = tempfile::tempdir().unwrap();
    let dev = info("Ascent_lite", FW);
    let p = write(&d, "Ascent_H_Sky_17_6_0_é.img", b"x");
    assert!(matches!(
        preflight(&dev, &p),
        Err(PreflightError::BadFileName)
    ));
    let p = write(&d, "Ascent\tH_Sky_17_6_0.img", b"x");
    assert!(matches!(
        preflight(&dev, &p),
        Err(PreflightError::BadFileName)
    ));
}
