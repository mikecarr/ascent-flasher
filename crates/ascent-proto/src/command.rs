//! Command ids used on the AR serial link.

#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Reboot = 3,
    FindDevice = 60,
    RemoteUpgrade = 114,
    SendFileStart = 115,
    SendFileData = 116,
    SendFileEnd = 117,
    UpgradeStatus = 118,
}

impl Command {
    pub fn id(self) -> u32 {
        self as u32
    }
}
