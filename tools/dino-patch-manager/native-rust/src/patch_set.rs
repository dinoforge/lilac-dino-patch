//! Non-mutating catalog and preflight model for the three DinoPatch features.
//!
//! This module keeps the feature catalog separate from mutation. Only a
//! combination with an exact registered fingerprint and passing isolated
//! transaction verification may be installed by the transaction engine.

pub const VERIFIED_APP_VERSION: &str = "0.5.65";
pub const OFFICIAL_V065_SHA256: &str =
    "9A5BBCDDDA592F173D6E1C5BC01AC0BBBEC8D003C40CB3A4113AFB307A08DA12";
pub const PATCH_01_V065_R1_SHA256: &str =
    "E4B53CA6EFF1C54D5057CCDE1AAC9382B0C1F2EC9612F484968D5C41A6C600B8";
pub const PATCH_02_V065_R1_SHA256: &str =
    "7E8ADBEBCF8B5DA8B2523ACD0A72FF48DCF94885AD2331278A324F0A597D0F0F";
pub const PATCH_03_V065_R1_SHA256: &str =
    "A876933021AF2333FE30400E8144F461EBAAA5896CFA6DBC5C0B06E44504BBA6";
pub const PATCH_01_02_V065_R1_SHA256: &str =
    "CC0A6FD86224F75CECBD9083394612AF4E1C579DAD8B98523D4853287F2838AC";
pub const PATCH_01_03_V065_R1_SHA256: &str =
    "6771ACB2D5F27AC19C0AE003F4F4ABBCB15E74F49EA9C1FA0BF30FC888A434D5";
pub const PATCH_02_03_V065_R1_SHA256: &str =
    "108E11BF20473BC70BA4A87A366A7519565081931DA0B03E2D58D4954F522741";
pub const PATCH_01_02_03_V065_R1_SHA256: &str =
    "A253DA2F71EBE4AB46F487B115706FA5919BEB063490D9C80E27671DA8C95647";
pub const PATCH_02_V065_R2_SHA256: &str =
    "5208A0E5B8ADEC13830A4F5DA83D54E85232A3148EA2769A2ACE273258A4D71B";
pub const PATCH_01_02_V065_R2_SHA256: &str =
    "4784DDECC263BEC8B8DDD8BEA8D1C49237EDFC3D81735131A2B27CAE010BBC52";
pub const PATCH_02_03_V065_R2_SHA256: &str =
    "C201D0FBFF99688C8D7A7547E0C0C484DBF72EB112A74F4B54EA4858E9DB1E8E";
pub const PATCH_01_02_03_V065_R2_SHA256: &str =
    "5DC84F77BF1719D36BC7C8F04FD273CEE727AF7F8B5150FC34D9AE5DA294532E";
pub const PATCH_02_V065_R3_SHA256: &str =
    "DE6686497397B7F727CCB8008534FBFEC799BC5AF08B4C24B1E6F4F11E5E2AF6";
pub const PATCH_01_02_V065_R3_SHA256: &str =
    "7B1571EBFAF8B3D08891C2F81E392CB911878BE3E19844A67AFA3C1307A3A908";

// Backward-compatible names used by existing tests and bundle code. These
// constants intentionally remain pinned to r1 as the latest capability moves
// independently when a later revision is verified.
pub const PATCH_01_V065_SHA256: &str = PATCH_01_V065_R1_SHA256;
pub const PATCH_02_V065_PREVIEW_SHA256: &str = PATCH_02_V065_R1_SHA256;
pub const PATCH_03_V065_PREVIEW_SHA256: &str = PATCH_03_V065_R1_SHA256;
pub const PREVIEW_0102_V065_SHA256: &str = PATCH_01_02_V065_R1_SHA256;
pub const PREVIEW_0103_V065_SHA256: &str = PATCH_01_03_V065_R1_SHA256;
pub const PREVIEW_0203_V065_SHA256: &str = PATCH_02_03_V065_R1_SHA256;
pub const PREVIEW_0123_V065_SHA256: &str = PATCH_01_02_03_V065_R1_SHA256;
const LEGACY_PATCH_VERSION: &str = "1.0.0";
const PATCH_02_R1_CHANGED_FILES: &[&str] =
    &["src/adult-catalog.css", "src/app.js", "src/index.html"];
const PATCH_02_R2_CHANGED_FILES: &[&str] = &[
    "electron/adult-catalog-metadata.cjs",
    "electron/main.cjs",
    "electron/preload.cjs",
    "src/adult-catalog.css",
    "src/app.js",
    "src/index.html",
];
const PATCH_03_R1_CHANGED_FILES: &[&str] = &["src/app.js", "src/index.html"];
const PATCH_01_R1_CHANGED_FILES: &[&str] = &[
    "electron/dino-work-db.cjs",
    "electron/main.cjs",
    "electron/preload.cjs",
    "src/app.js",
    "src/dino-sqlite-sync.js",
    "src/index.html",
    "src/integrated-search.css",
    "src/integrated-search.js",
    "src/patch03-bridge.js",
];
const PATCH_01_02_03_R1_CHANGED_FILES: &[&str] = &[
    "electron/dino-work-db.cjs",
    "electron/main.cjs",
    "electron/preload.cjs",
    "src/adult-catalog.css",
    "src/app.js",
    "src/dino-sqlite-sync.js",
    "src/index.html",
    "src/integrated-search.css",
    "src/integrated-search.js",
    "src/patch03-bridge.js",
];
const PATCH_01_02_R2_CHANGED_FILES: &[&str] = &[
    "electron/adult-catalog-metadata.cjs",
    "electron/dino-work-db.cjs",
    "electron/main.cjs",
    "electron/preload.cjs",
    "src/adult-catalog.css",
    "src/app.js",
    "src/dino-sqlite-sync.js",
    "src/index.html",
    "src/integrated-search.css",
    "src/integrated-search.js",
    "src/patch03-bridge.js",
];

#[cfg(test)]
const PATCH_01_CHANGED_FILES: &[&str] = PATCH_01_R1_CHANGED_FILES;
#[cfg(test)]
const PATCH_02_CHANGED_FILES: &[&str] = PATCH_02_R1_CHANGED_FILES;
#[cfg(test)]
const PATCH_03_CHANGED_FILES: &[&str] = PATCH_03_R1_CHANGED_FILES;
#[cfg(test)]
const PREVIEW_0123_CHANGED_FILES: &[&str] = PATCH_01_02_03_R1_CHANGED_FILES;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PatchId {
    IntegratedSearchProviderSwitch,
    AdultOnlyTab,
    DoubleSpeedBuffering,
}

impl PatchId {
    pub const ALL: [Self; 3] = [
        Self::IntegratedSearchProviderSwitch,
        Self::AdultOnlyTab,
        Self::DoubleSpeedBuffering,
    ];

    pub const fn code(self) -> &'static str {
        match self {
            Self::IntegratedSearchProviderSwitch => "01",
            Self::AdultOnlyTab => "02",
            Self::DoubleSpeedBuffering => "03",
        }
    }

    pub const fn display_name(self) -> &'static str {
        match self {
            Self::IntegratedSearchProviderSwitch => "통합 검색·공급원 전환",
            Self::AdultOnlyTab => "야애니 전용 탭",
            Self::DoubleSpeedBuffering => "2배속 버퍼링 최적화",
        }
    }

    pub const fn description(self) -> &'static str {
        match self {
            Self::IntegratedSearchProviderSwitch => {
                "여러 애니 공급원을 통합 검색하고 원하는 공급원으로 전환합니다."
            }
            Self::AdultOnlyTab => "검증된 v0.5.65 조합에서 선택 적용할 수 있습니다.",
            Self::DoubleSpeedBuffering => {
                "성능 개선이 확인되지 않아 신규 적용을 보류했습니다. 기존 적용본은 해제하거나 01·02 조합으로 변경할 수 있습니다."
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeatureAvailability {
    ManagerSelectable,
    NewInstallPaused,
    PreviewOnly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PatchDefinition {
    pub id: PatchId,
    pub display_name: &'static str,
    pub description: &'static str,
    pub availability: FeatureAvailability,
}

pub const PATCH_CATALOG: [PatchDefinition; 3] = [
    PatchDefinition {
        id: PatchId::IntegratedSearchProviderSwitch,
        display_name: PatchId::IntegratedSearchProviderSwitch.display_name(),
        description: PatchId::IntegratedSearchProviderSwitch.description(),
        availability: FeatureAvailability::ManagerSelectable,
    },
    PatchDefinition {
        id: PatchId::AdultOnlyTab,
        display_name: PatchId::AdultOnlyTab.display_name(),
        description: PatchId::AdultOnlyTab.description(),
        availability: FeatureAvailability::ManagerSelectable,
    },
    PatchDefinition {
        id: PatchId::DoubleSpeedBuffering,
        display_name: PatchId::DoubleSpeedBuffering.display_name(),
        description: PatchId::DoubleSpeedBuffering.description(),
        availability: FeatureAvailability::NewInstallPaused,
    },
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PatchSet(u8);

/// Historical fingerprints for Patch 03 remain registered so installed
/// compositions can be inspected, uninstalled, and transitioned safely.
/// New installs are limited to the 01/02 feature set until Patch 03 passes its
/// playback-performance acceptance gates.
pub const fn new_install_allowed(set: PatchSet) -> bool {
    !set.contains(PatchId::DoubleSpeedBuffering)
}

impl PatchSet {
    const PATCH_01: u8 = 0b001;
    const PATCH_02: u8 = 0b010;
    const PATCH_03: u8 = 0b100;
    const PATCH_01_02: u8 = Self::PATCH_01 | Self::PATCH_02;
    const PATCH_01_03: u8 = Self::PATCH_01 | Self::PATCH_03;
    const PATCH_02_03: u8 = Self::PATCH_02 | Self::PATCH_03;
    const FULL_SET: u8 = Self::PATCH_01 | Self::PATCH_02 | Self::PATCH_03;

    pub fn from_ids(ids: &[PatchId]) -> Result<Self, &'static str> {
        if ids.is_empty() {
            return Err("패치 조합은 비어 있을 수 없습니다.");
        }
        let mut bits = 0;
        for id in ids {
            let bit = match id {
                PatchId::IntegratedSearchProviderSwitch => Self::PATCH_01,
                PatchId::AdultOnlyTab => Self::PATCH_02,
                PatchId::DoubleSpeedBuffering => Self::PATCH_03,
            };
            if bits & bit != 0 {
                return Err("패치 ID가 중복됐습니다.");
            }
            bits |= bit;
        }
        Ok(Self(bits))
    }

    pub fn parse_id(value: &str) -> Result<Self, &'static str> {
        let mut ids = Vec::new();
        for code in value.split('+') {
            let id = match code {
                "01" => PatchId::IntegratedSearchProviderSwitch,
                "02" => PatchId::AdultOnlyTab,
                "03" => PatchId::DoubleSpeedBuffering,
                _ => return Err("알 수 없는 패치 ID입니다."),
            };
            ids.push(id);
        }
        let set = Self::from_ids(&ids)?;
        if set.id() != value {
            return Err("패치 조합 ID가 정규 순서가 아닙니다.");
        }
        Ok(set)
    }

    pub fn id(self) -> String {
        PatchId::ALL
            .into_iter()
            .filter(|id| self.contains(*id))
            .map(PatchId::code)
            .collect::<Vec<_>>()
            .join("+")
    }

    pub const fn contains(self, id: PatchId) -> bool {
        let bit = match id {
            PatchId::IntegratedSearchProviderSwitch => Self::PATCH_01,
            PatchId::AdultOnlyTab => Self::PATCH_02,
            PatchId::DoubleSpeedBuffering => Self::PATCH_03,
        };
        self.0 & bit != 0
    }

    pub fn logical_combinations() -> [Self; 7] {
        [
            Self(Self::PATCH_01),
            Self(Self::PATCH_02),
            Self(Self::PATCH_03),
            Self(Self::PATCH_01 | Self::PATCH_02),
            Self(Self::PATCH_01 | Self::PATCH_03),
            Self(Self::PATCH_02 | Self::PATCH_03),
            Self(Self::PATCH_01 | Self::PATCH_02 | Self::PATCH_03),
        ]
    }
}

/// A user-confirmable target selection. Unlike `PatchSet`, it can represent
/// an empty selection without treating that as an installable composition.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PatchSelection(u8);

impl PatchSelection {
    const PATCH_01: u8 = 0b001;
    const PATCH_02: u8 = 0b010;
    const PATCH_03: u8 = 0b100;

    pub const NONE: Self = Self(0);
    /// Preserve the manager's existing default behavior: patch 01 is the
    /// confirmed target until the user explicitly saves another selection.
    pub const DEFAULT: Self = Self(Self::PATCH_01);

    pub fn from_ids(ids: &[PatchId]) -> Result<Self, &'static str> {
        if ids.is_empty() {
            return Ok(Self::NONE);
        }
        let set = PatchSet::from_ids(ids)?;
        Ok(Self(set.0))
    }

    pub fn parse_id(value: &str) -> Result<Self, &'static str> {
        if value == "NONE" {
            return Ok(Self::NONE);
        }
        let set = PatchSet::parse_id(value)?;
        Ok(Self(set.0))
    }

    pub fn id(self) -> String {
        if self.is_empty() {
            "NONE".to_owned()
        } else {
            PatchSet(self.0).id()
        }
    }

    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub const fn contains(self, id: PatchId) -> bool {
        let bit = match id {
            PatchId::IntegratedSearchProviderSwitch => Self::PATCH_01,
            PatchId::AdultOnlyTab => Self::PATCH_02,
            PatchId::DoubleSpeedBuffering => Self::PATCH_03,
        };
        self.0 & bit != 0
    }

    pub const fn with(self, id: PatchId, selected: bool) -> Self {
        let bit = match id {
            PatchId::IntegratedSearchProviderSwitch => Self::PATCH_01,
            PatchId::AdultOnlyTab => Self::PATCH_02,
            PatchId::DoubleSpeedBuffering => Self::PATCH_03,
        };
        if selected {
            Self(self.0 | bit)
        } else {
            Self(self.0 & !bit)
        }
    }

    pub fn manager_install_supported(self) -> bool {
        self.as_patch_set().is_some_and(|set| {
            combination_capability(set).manager_install == ManagerInstallSupport::Supported
        })
    }

    pub fn as_patch_set(self) -> Option<PatchSet> {
        (!self.is_empty()).then_some(PatchSet(self.0))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GenerationSupport {
    None,
    ExistingManagedPatch,
    SelectedOfflinePreview,
    CombinedOfflinePreview,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ManagerInstallSupport {
    Supported,
    PreviewOnly,
    Unsupported,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KnownFingerprint {
    pub app_version: &'static str,
    pub original_sha256: &'static str,
    pub result_sha256: &'static str,
    pub changed_files: &'static [&'static str],
    pub evidence: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CombinationCapability {
    pub generation: GenerationSupport,
    pub manager_install: ManagerInstallSupport,
    pub fingerprint: Option<KnownFingerprint>,
}

/// A registered output for one combination and revision. A preview receipt is
/// never a registration; this catalog is the install authorization boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PatchRevision {
    pub id: &'static str,
    pub number: u16,
    pub installable: bool,
    pub fingerprint: KnownFingerprint,
}

fn resolve_revision_in(
    revisions: &[PatchRevision],
    revision_id: Option<&str>,
    app_version: &str,
    original_sha256: &str,
    result_sha256: &str,
) -> Option<PatchRevision> {
    let mut matches = revisions.iter().copied().filter(|revision| {
        let fingerprint = revision.fingerprint;
        revision_id.is_none_or(|id| id == revision.id)
            && app_version == fingerprint.app_version
            && original_sha256.eq_ignore_ascii_case(fingerprint.original_sha256)
            && result_sha256.eq_ignore_ascii_case(fingerprint.result_sha256)
    });
    let matched = matches.next()?;
    matches.next().is_none().then_some(matched)
}

/// Immutable r1 fingerprints. Keep these entries even after a newer revision
/// becomes the latest capability so legacy installs remain inspectable and
/// restorable. The registry below is the only place new revision IDs belong.
fn r1_fingerprint(set: PatchSet) -> Option<KnownFingerprint> {
    let (result_sha256, changed_files, evidence) = match set.0 {
        PatchSet::PATCH_01 => (
            PATCH_01_V065_R1_SHA256,
            PATCH_01_R1_CHANGED_FILES,
            "격리 v0.5.65 관리자 적용·해제 기록",
        ),
        PatchSet::PATCH_02 => (
            PATCH_02_V065_R1_SHA256,
            PATCH_02_R1_CHANGED_FILES,
            "공식 v0.5.65 원본 기반 선택 ASAR 생성·관리자 설치·전환 복구·원본 복원 격리 E2E",
        ),
        PatchSet::PATCH_03 => (
            PATCH_03_V065_R1_SHA256,
            PATCH_03_R1_CHANGED_FILES,
            "공식 v0.5.65 원본 기반 선택 ASAR 생성·관리자 설치·전환 복구·원본 복원 격리 E2E",
        ),
        PatchSet::PATCH_01_02 => (
            PATCH_01_02_V065_R1_SHA256,
            PATCH_01_02_03_R1_CHANGED_FILES,
            "공식 v0.5.65 원본 기반 선택 ASAR 생성·관리자 설치·전환 복구·원본 복원 격리 E2E",
        ),
        PatchSet::PATCH_01_03 => (
            PATCH_01_03_V065_R1_SHA256,
            PATCH_01_R1_CHANGED_FILES,
            "공식 v0.5.65 원본 기반 선택 ASAR 생성·관리자 설치·전환 복구·원본 복원 격리 E2E",
        ),
        PatchSet::PATCH_02_03 => (
            PATCH_02_03_V065_R1_SHA256,
            PATCH_02_R1_CHANGED_FILES,
            "공식 v0.5.65 원본 기반 선택 ASAR 생성·관리자 설치·전환 복구·원본 복원 격리 E2E",
        ),
        PatchSet::FULL_SET => (
            PATCH_01_02_03_V065_R1_SHA256,
            PATCH_01_02_03_R1_CHANGED_FILES,
            "공식 v0.5.65 원본 기반 통합 ASAR 관리자 설치·전환 복구·원본 복원 격리 E2E",
        ),
        _ => return None,
    };
    Some(KnownFingerprint {
        app_version: VERIFIED_APP_VERSION,
        original_sha256: OFFICIAL_V065_SHA256,
        result_sha256,
        changed_files,
        evidence,
    })
}

fn r2_fingerprint(set: PatchSet) -> Option<KnownFingerprint> {
    let (result_sha256, changed_files) = match set.0 {
        PatchSet::PATCH_02 => (PATCH_02_V065_R2_SHA256, PATCH_02_R2_CHANGED_FILES),
        PatchSet::PATCH_01_02 => (PATCH_01_02_V065_R2_SHA256, PATCH_01_02_R2_CHANGED_FILES),
        PatchSet::PATCH_02_03 => (PATCH_02_03_V065_R2_SHA256, PATCH_02_R2_CHANGED_FILES),
        PatchSet::FULL_SET => (PATCH_01_02_03_V065_R2_SHA256, PATCH_01_02_R2_CHANGED_FILES),
        _ => return None,
    };
    Some(KnownFingerprint {
        app_version: VERIFIED_APP_VERSION,
        original_sha256: OFFICIAL_V065_SHA256,
        result_sha256,
        changed_files,
        evidence: "공식 v0.5.65 원본 기반 AniList 명시 Hentai 메타데이터 연결 r2; 실제 ASAR 계약 및 격리 전환·복원 E2E",
    })
}

fn r3_fingerprint(set: PatchSet) -> Option<KnownFingerprint> {
    let (result_sha256, changed_files) = match set.0 {
        PatchSet::PATCH_02 => (PATCH_02_V065_R3_SHA256, PATCH_02_R2_CHANGED_FILES),
        PatchSet::PATCH_01_02 => (PATCH_01_02_V065_R3_SHA256, PATCH_01_02_R2_CHANGED_FILES),
        _ => return None,
    };
    Some(KnownFingerprint {
        app_version: VERIFIED_APP_VERSION,
        original_sha256: OFFICIAL_V065_SHA256,
        result_sha256,
        changed_files,
        evidence: "공식 v0.5.65 원본 기반 검증 메타데이터 캐시 r3; 실제 ASAR 계약·격리 전환·원본 복원 검증",
    })
}

/// All registered fingerprints, including superseded revisions. Add a later
/// revision only after its exact output, selection, transition and recovery
/// results are verified. Preview receipts never add entries here.
pub fn registered_revisions(set: PatchSet) -> Vec<PatchRevision> {
    let mut revisions = match r1_fingerprint(set) {
        Some(fingerprint) => vec![PatchRevision {
            id: "r1",
            number: 1,
            installable: true,
            fingerprint,
        }],
        None => Vec::new(),
    };

    if let Some(fingerprint) = r2_fingerprint(set) {
        revisions.push(PatchRevision {
            id: "r2",
            number: 2,
            installable: true,
            fingerprint,
        });
    }

    if let Some(fingerprint) = r3_fingerprint(set) {
        revisions.push(PatchRevision {
            id: "r3",
            number: 3,
            installable: true,
            fingerprint,
        });
    }

    revisions.sort_by_key(|revision| revision.number);
    revisions
}

pub fn resolve_registered_revision(
    set: PatchSet,
    revision_id: Option<&str>,
    app_version: &str,
    original_sha256: &str,
    result_sha256: &str,
) -> Option<PatchRevision> {
    resolve_revision_in(
        &registered_revisions(set),
        revision_id,
        app_version,
        original_sha256,
        result_sha256,
    )
}

pub fn latest_installable_revision(set: PatchSet) -> Option<PatchRevision> {
    registered_revisions(set)
        .into_iter()
        .filter(|revision| revision.installable)
        .max_by_key(|revision| revision.number)
}

fn revision_update_available(
    installed: PatchRevision,
    revisions: &[PatchRevision],
) -> bool {
    revisions
        .iter()
        .filter(|revision| revision.installable)
        .max_by_key(|revision| revision.number)
        .is_some_and(|latest| latest.number > installed.number)
}

fn selected_preview_capability(
    result_sha256: &'static str,
    changed_files: &'static [&'static str],
) -> CombinationCapability {
    CombinationCapability {
        generation: GenerationSupport::SelectedOfflinePreview,
        manager_install: ManagerInstallSupport::Supported,
        fingerprint: Some(KnownFingerprint {
            app_version: VERIFIED_APP_VERSION,
            original_sha256: OFFICIAL_V065_SHA256,
            result_sha256,
            changed_files,
            evidence: "공식 v0.5.65 원본 기반 선택 ASAR 생성·관리자 설치·전환 복구·원본 복원 격리 E2E",
        }),
    }
}

pub fn combination_capability(set: PatchSet) -> CombinationCapability {
    let mut capability = match set.0 {
        PatchSet::PATCH_01 => CombinationCapability {
            generation: GenerationSupport::ExistingManagedPatch,
            manager_install: ManagerInstallSupport::Supported,
            fingerprint: Some(KnownFingerprint {
                app_version: VERIFIED_APP_VERSION,
                original_sha256: OFFICIAL_V065_SHA256,
                result_sha256: PATCH_01_V065_SHA256,
                changed_files: PATCH_01_R1_CHANGED_FILES,
                evidence: "격리 v0.5.65 관리자 적용·해제 기록",
            }),
        },
        PatchSet::PATCH_02 => {
            selected_preview_capability(PATCH_02_V065_R1_SHA256, PATCH_02_R1_CHANGED_FILES)
        }
        PatchSet::PATCH_03 => {
            selected_preview_capability(PATCH_03_V065_R1_SHA256, PATCH_03_R1_CHANGED_FILES)
        }
        PatchSet::PATCH_01_02 => {
            selected_preview_capability(PATCH_01_02_V065_R1_SHA256, PATCH_01_02_03_R1_CHANGED_FILES)
        }
        PatchSet::PATCH_01_03 => {
            selected_preview_capability(PATCH_01_03_V065_R1_SHA256, PATCH_01_R1_CHANGED_FILES)
        }
        PatchSet::PATCH_02_03 => {
            selected_preview_capability(PATCH_02_03_V065_R1_SHA256, PATCH_02_R1_CHANGED_FILES)
        }
        PatchSet::FULL_SET => {
            CombinationCapability {
                generation: GenerationSupport::CombinedOfflinePreview,
                manager_install: ManagerInstallSupport::Supported,
                fingerprint: Some(KnownFingerprint {
                    app_version: VERIFIED_APP_VERSION,
                    original_sha256: OFFICIAL_V065_SHA256,
                    result_sha256: PATCH_01_02_03_V065_R1_SHA256,
                    changed_files: PATCH_01_02_03_R1_CHANGED_FILES,
                    evidence: "공식 v0.5.65 원본 기반 통합 ASAR 관리자 설치·전환 복구·원본 복원 격리 E2E",
                }),
            }
        }
        _ => CombinationCapability {
            generation: GenerationSupport::None,
            manager_install: ManagerInstallSupport::Unsupported,
            fingerprint: None,
        },
    };
    capability.fingerprint = latest_installable_revision(set).map(|revision| revision.fingerprint);
    if !new_install_allowed(set) {
        capability.manager_install = ManagerInstallSupport::Unsupported;
    }
    capability
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CandidateManifest<'a> {
    pub combination_id: &'a str,
    /// Missing in legacy receipts. Those are resolved by the exact registered
    /// result SHA-256 rather than by guessing a revision.
    pub revision_id: Option<&'a str>,
    pub app_version: &'a str,
    pub original_sha256: &'a str,
    pub result_sha256: &'a str,
    pub changed_files: &'a [&'a str],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CandidateCheck {
    VerifiedKnownOutput,
    InvalidCombinationId,
    UnknownRevision,
    NoVerifiedOutput,
    UnsupportedVersion,
    OriginalHashMismatch,
    ResultHashMismatch,
    ChangedFilesMismatch,
}

pub fn verify_candidate(candidate: CandidateManifest<'_>) -> CandidateCheck {
    let Ok(set) = PatchSet::parse_id(candidate.combination_id) else {
        return CandidateCheck::InvalidCombinationId;
    };
    let revisions = registered_revisions(set);
    if combination_capability(set).generation == GenerationSupport::None {
        return CandidateCheck::NoVerifiedOutput;
    }
    if candidate
        .revision_id
        .is_some_and(|id| !revisions.iter().any(|revision| revision.id == id))
    {
        return CandidateCheck::UnknownRevision;
    }
    let expected_revision = revisions
        .iter()
        .find(|revision| {
            candidate.revision_id.map_or_else(
                || {
                    candidate
                        .result_sha256
                        .eq_ignore_ascii_case(revision.fingerprint.result_sha256)
                },
                |id| id == revision.id,
            )
        })
        .copied()
        .or_else(|| latest_installable_revision(set));
    let Some(fingerprint) = expected_revision.map(|revision| revision.fingerprint) else {
        return CandidateCheck::NoVerifiedOutput;
    };
    if candidate.app_version != fingerprint.app_version {
        return CandidateCheck::UnsupportedVersion;
    }
    if !candidate.original_sha256.eq_ignore_ascii_case(fingerprint.original_sha256) {
        return CandidateCheck::OriginalHashMismatch;
    }
    if !candidate.result_sha256.eq_ignore_ascii_case(fingerprint.result_sha256) {
        return CandidateCheck::ResultHashMismatch;
    }
    if candidate.changed_files != fingerprint.changed_files {
        return CandidateCheck::ChangedFilesMismatch;
    }
    if resolve_revision_in(
        &revisions,
        candidate.revision_id,
        candidate.app_version,
        candidate.original_sha256,
        candidate.result_sha256,
    )
    .is_none()
    {
        return CandidateCheck::ResultHashMismatch;
    }
    CandidateCheck::VerifiedKnownOutput
}

pub fn candidate_manager_install_supported(candidate: CandidateManifest<'_>) -> bool {
    if verify_candidate(candidate) != CandidateCheck::VerifiedKnownOutput {
        return false;
    }
    let Ok(set) = PatchSet::parse_id(candidate.combination_id) else {
        return false;
    };
    if !new_install_allowed(set) {
        return false;
    }
    let Some(revision) = resolve_registered_revision(
        set,
        candidate.revision_id,
        candidate.app_version,
        candidate.original_sha256,
        candidate.result_sha256,
    ) else {
        return false;
    };
    revision.installable
        && latest_installable_revision(set).is_some_and(|latest| latest.id == revision.id)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AppliedRecord<'a> {
    /// Absent in the legacy transaction format; patchVersion 1.0.0 maps only to 01.
    pub combination_id: Option<&'a str>,
    /// Absent in r1 legacy records. The exact hash still must resolve uniquely.
    pub revision_id: Option<&'a str>,
    pub patch_version: &'a str,
    pub app_version: &'a str,
    pub status: &'a str,
    pub original_sha256: &'a str,
    pub result_sha256: &'a str,
    pub backup_sha256: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CurrentInstall<'a> {
    pub app_version: &'a str,
    pub actual_sha256: &'a str,
    pub has_unrecorded_patch_modules: bool,
    pub record: Option<AppliedRecord<'a>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ManagerState {
    NotApplied,
    Applied,
    RevisionUpdateAvailable,
    TransitionRequired,
    UnsupportedCombination,
    Conflict,
    Unknown,
}

impl ManagerState {
    pub const fn label(self) -> &'static str {
        match self {
            Self::NotApplied => "미적용",
            Self::Applied => "적용됨",
            Self::RevisionUpdateAvailable => "개정판 업데이트 가능",
            Self::TransitionRequired => "조합 전환 필요",
            Self::UnsupportedCombination => "지원되지 않는 조합",
            Self::Conflict => "기록과 실제 파일 충돌",
            Self::Unknown => "상태 확인 불가",
        }
    }
}

fn recorded_set(record: AppliedRecord<'_>) -> Option<PatchSet> {
    match record.combination_id {
        Some(id) => PatchSet::parse_id(id).ok(),
        None if record.patch_version == LEGACY_PATCH_VERSION => {
            PatchSet::from_ids(&[PatchId::IntegratedSearchProviderSwitch]).ok()
        }
        None => None,
    }
}

fn record_matches_known_output(record: AppliedRecord<'_>, set: PatchSet) -> bool {
    resolve_registered_revision(
        set,
        record.revision_id,
        record.app_version,
        record.original_sha256,
        record.result_sha256,
    )
    .is_some()
}

pub fn classify_current(desired: PatchSet, current: CurrentInstall<'_>) -> ManagerState {
    if let Some(record) = current.record {
        let Some(installed_set) = recorded_set(record) else {
            return ManagerState::Unknown;
        };
        if !record_matches_known_output(record, installed_set)
            || record.app_version != current.app_version
        {
            return ManagerState::Unknown;
        }
        match record.status {
            "APPLIED" => {
                if !current.actual_sha256.eq_ignore_ascii_case(record.result_sha256) {
                    return ManagerState::Conflict;
                }
                if !record
                    .backup_sha256
                    .is_some_and(|backup| backup.eq_ignore_ascii_case(record.original_sha256))
                {
                    return ManagerState::Unknown;
                }
                if desired == installed_set {
                    let Some(installed_revision) = resolve_registered_revision(
                        installed_set,
                        record.revision_id,
                        record.app_version,
                        record.original_sha256,
                        record.result_sha256,
                    ) else {
                        return ManagerState::Unknown;
                    };
                    if new_install_allowed(installed_set)
                        && revision_update_available(
                            installed_revision,
                            &registered_revisions(installed_set),
                        )
                    {
                        ManagerState::RevisionUpdateAvailable
                    } else {
                        ManagerState::Applied
                    }
                } else {
                    ManagerState::TransitionRequired
                }
            }
            "UNPATCHED" => {
                if !current.actual_sha256.eq_ignore_ascii_case(record.original_sha256) {
                    return ManagerState::Conflict;
                }
                if desired == installed_set {
                    ManagerState::NotApplied
                } else {
                    ManagerState::TransitionRequired
                }
            }
            _ => ManagerState::Unknown,
        }
    } else {
        if current.has_unrecorded_patch_modules {
            return ManagerState::Unknown;
        }
        if current.app_version != VERIFIED_APP_VERSION
            || !current.actual_sha256.eq_ignore_ascii_case(OFFICIAL_V065_SHA256)
        {
            return ManagerState::Unknown;
        }
        if combination_capability(desired).manager_install != ManagerInstallSupport::Supported {
            return ManagerState::UnsupportedCombination;
        }
        ManagerState::NotApplied
    }
}

pub fn can_restore(record: AppliedRecord<'_>, current: CurrentInstall<'_>) -> bool {
    if record.status != "APPLIED" || record.app_version != current.app_version {
        return false;
    }
    let Some(set) = recorded_set(record) else {
        return false;
    };
    record_matches_known_output(record, set)
        && current.actual_sha256.eq_ignore_ascii_case(record.result_sha256)
        && record
            .backup_sha256
            .is_some_and(|backup| backup.eq_ignore_ascii_case(record.original_sha256))
}

pub fn install_preflight(
    desired: PatchSet,
    candidate: CandidateManifest<'_>,
    current: CurrentInstall<'_>,
) -> bool {
    candidate_manager_install_supported(candidate)
        && PatchSet::parse_id(candidate.combination_id).is_ok_and(|candidate_set| candidate_set == desired)
        && classify_current(desired, current) == ManagerState::NotApplied
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one() -> PatchSet {
        PatchSet::from_ids(&[PatchId::IntegratedSearchProviderSwitch]).unwrap()
    }

    fn all() -> PatchSet {
        PatchSet::from_ids(&[
            PatchId::IntegratedSearchProviderSwitch,
            PatchId::AdultOnlyTab,
            PatchId::DoubleSpeedBuffering,
        ])
        .unwrap()
    }

    fn manifest(id: &'static str, result: &'static str) -> CandidateManifest<'static> {
        let changed_files = PatchSet::parse_id(id)
            .ok()
            .and_then(|set| {
                resolve_registered_revision(
                    set,
                    None,
                    VERIFIED_APP_VERSION,
                    OFFICIAL_V065_SHA256,
                    result,
                )
            })
            .map(|revision| revision.fingerprint.changed_files)
            .unwrap_or(&[]);
        CandidateManifest {
            combination_id: id,
            revision_id: None,
            app_version: VERIFIED_APP_VERSION,
            original_sha256: OFFICIAL_V065_SHA256,
            result_sha256: result,
            changed_files,
        }
    }

    fn official() -> CurrentInstall<'static> {
        CurrentInstall {
            app_version: VERIFIED_APP_VERSION,
            actual_sha256: OFFICIAL_V065_SHA256,
            has_unrecorded_patch_modules: false,
            record: None,
        }
    }

    fn legacy_applied() -> AppliedRecord<'static> {
        AppliedRecord {
            combination_id: None,
            revision_id: None,
            patch_version: LEGACY_PATCH_VERSION,
            app_version: VERIFIED_APP_VERSION,
            status: "APPLIED",
            original_sha256: OFFICIAL_V065_SHA256,
            result_sha256: PATCH_01_V065_SHA256,
            backup_sha256: Some(OFFICIAL_V065_SHA256),
        }
    }

    #[test]
    fn catalog_has_unique_ids_and_the_three_user_names() {
        assert_eq!(PATCH_CATALOG.map(|entry| entry.id.code()), ["01", "02", "03"]);
        assert_eq!(
            PATCH_CATALOG.map(|entry| entry.display_name),
            ["통합 검색·공급원 전환", "야애니 전용 탭", "2배속 버퍼링 최적화"]
        );
        assert_eq!(
            PATCH_CATALOG.map(|entry| entry.availability),
            [
                FeatureAvailability::ManagerSelectable,
                FeatureAvailability::ManagerSelectable,
                FeatureAvailability::NewInstallPaused,
            ]
        );
    }

    #[test]
    fn seven_logical_combinations_have_deterministic_canonical_ids() {
        let ids = PatchSet::logical_combinations().map(PatchSet::id);
        assert_eq!(ids, ["01", "02", "03", "01+02", "01+03", "02+03", "01+02+03"]);
        let reverse = PatchSet::from_ids(&[
            PatchId::DoubleSpeedBuffering,
            PatchId::IntegratedSearchProviderSwitch,
            PatchId::AdultOnlyTab,
        ])
        .unwrap();
        assert_eq!(reverse.id(), "01+02+03");
        assert!(PatchSet::from_ids(&[]).is_err());
        assert!(PatchSet::from_ids(&[PatchId::AdultOnlyTab, PatchId::AdultOnlyTab]).is_err());
        assert!(PatchSet::parse_id("03+01").is_err());
    }

    #[test]
    fn all_seven_registered_combinations_remain_identifiable_but_only_01_02_sets_are_newly_installable() {
        for set in PatchSet::logical_combinations() {
            let capability = combination_capability(set);
            let fingerprint = capability.fingerprint.expect("verified preview fingerprint");
            let id = set.id();
            let install_allowed = new_install_allowed(set);
            let (expected_result_sha256, expected_changed_files) = match id.as_str() {
                "01" => (PATCH_01_V065_SHA256, PATCH_01_CHANGED_FILES),
                "02" => (PATCH_02_V065_R3_SHA256, PATCH_02_R2_CHANGED_FILES),
                "03" => (PATCH_03_V065_PREVIEW_SHA256, PATCH_03_CHANGED_FILES),
                "01+02" => (PATCH_01_02_V065_R3_SHA256, PATCH_01_02_R2_CHANGED_FILES),
                "01+03" => (PREVIEW_0103_V065_SHA256, PATCH_01_CHANGED_FILES),
                "02+03" => (PATCH_02_03_V065_R2_SHA256, PATCH_02_R2_CHANGED_FILES),
                "01+02+03" => (PATCH_01_02_03_V065_R2_SHA256, PATCH_01_02_R2_CHANGED_FILES),
                _ => panic!("unexpected patch combination: {id}"),
            };
            assert_eq!(fingerprint.result_sha256, expected_result_sha256);
            assert_eq!(fingerprint.changed_files, expected_changed_files);
            let revisions = registered_revisions(set);
            let has_r2 = set.contains(PatchId::AdultOnlyTab);
            let has_r3 = matches!(id.as_str(), "02" | "01+02");
            assert_eq!(revisions.len(), if has_r3 { 3 } else if has_r2 { 2 } else { 1 });
            assert_eq!(revisions[0].id, "r1");
            assert_eq!(revisions[0].number, 1);
            assert!(revisions[0].installable);
            let latest = revisions.last().unwrap();
            assert_eq!(latest.id, if has_r3 { "r3" } else if has_r2 { "r2" } else { "r1" });
            assert_eq!(capability.fingerprint, Some(latest.fingerprint));
            assert_eq!(
                resolve_registered_revision(
                    set,
                    None,
                    fingerprint.app_version,
                    fingerprint.original_sha256,
                    fingerprint.result_sha256,
                ),
                Some(*latest)
            );
            let candidate = CandidateManifest {
                combination_id: &id,
                revision_id: Some(latest.id),
                app_version: fingerprint.app_version,
                original_sha256: fingerprint.original_sha256,
                result_sha256: fingerprint.result_sha256,
                changed_files: fingerprint.changed_files,
            };
            assert_eq!(verify_candidate(candidate), CandidateCheck::VerifiedKnownOutput);
            assert_eq!(
                capability.manager_install,
                if install_allowed { ManagerInstallSupport::Supported } else { ManagerInstallSupport::Unsupported }
            );
            assert_eq!(candidate_manager_install_supported(candidate), install_allowed);

            if set == one() {
                assert_eq!(capability.generation, GenerationSupport::ExistingManagedPatch);
            } else if set == all() {
                assert_eq!(capability.generation, GenerationSupport::CombinedOfflinePreview);
            } else {
                assert_eq!(capability.generation, GenerationSupport::SelectedOfflinePreview);
                let selected_ids = PatchId::ALL
                    .into_iter()
                    .filter(|id| set.contains(*id))
                    .collect::<Vec<_>>();
                let selection = PatchSelection::from_ids(&selected_ids).unwrap();
                assert_eq!(selection.manager_install_supported(), install_allowed);
            }
        }
    }

    #[test]
    fn r1_registry_keeps_all_historical_composition_hashes_pinned() {
        let expected = [
            ("01", PATCH_01_V065_R1_SHA256),
            ("02", PATCH_02_V065_R1_SHA256),
            ("03", PATCH_03_V065_R1_SHA256),
            ("01+02", PATCH_01_02_V065_R1_SHA256),
            ("01+03", PATCH_01_03_V065_R1_SHA256),
            ("02+03", PATCH_02_03_V065_R1_SHA256),
            ("01+02+03", PATCH_01_02_03_V065_R1_SHA256),
        ];

        for (set, (expected_id, expected_sha256)) in PatchSet::logical_combinations()
            .into_iter()
            .zip(expected)
        {
            assert_eq!(set.id(), expected_id);
            let revisions = registered_revisions(set);
            let r1 = revisions.first().expect("r1 remains registered");
            assert_eq!(r1.id, "r1");
            assert_eq!(r1.number, 1);
            assert!(r1.installable);
            assert_eq!(r1.fingerprint.result_sha256, expected_sha256);
            assert_eq!(
                r1.fingerprint.original_sha256,
                OFFICIAL_V065_SHA256
            );
            if set.contains(PatchId::AdultOnlyTab) {
                let r2 = revisions.get(1).expect("verified r2 must coexist with r1");
                assert_eq!(r2.id, "r2");
                assert_eq!(r2.number, 2);
                assert!(r2.installable);
            } else {
                assert_eq!(revisions.len(), 1);
            }
        }
    }

    #[test]
    fn r3_registry_is_limited_to_newly_supported_02_compositions_and_preserves_r2() {
        for (set, expected_sha, expected_files, historical_r2_sha) in [
            (
                PatchSet::parse_id("02").unwrap(),
                PATCH_02_V065_R3_SHA256,
                PATCH_02_R2_CHANGED_FILES,
                PATCH_02_V065_R2_SHA256,
            ),
            (
                PatchSet::parse_id("01+02").unwrap(),
                PATCH_01_02_V065_R3_SHA256,
                PATCH_01_02_R2_CHANGED_FILES,
                PATCH_01_02_V065_R2_SHA256,
            ),
        ] {
            let revisions = registered_revisions(set);
            assert_eq!(revisions.iter().map(|revision| revision.id).collect::<Vec<_>>(), ["r1", "r2", "r3"]);
            let r2 = revisions[1];
            assert_eq!(r2.fingerprint.result_sha256, historical_r2_sha);
            let r3 = revisions[2];
            assert_eq!(r3.number, 3);
            assert!(r3.installable);
            assert_eq!(r3.fingerprint.result_sha256, expected_sha);
            assert_eq!(r3.fingerprint.changed_files, expected_files);
            assert_eq!(latest_installable_revision(set), Some(r3));
        }
        for set in [
            PatchSet::parse_id("02+03").unwrap(),
            PatchSet::parse_id("01+02+03").unwrap(),
        ] {
            assert!(registered_revisions(set).iter().all(|revision| revision.id != "r3"));
        }
    }

    #[test]
    fn a_legacy_r1_install_is_detected_as_update_available_and_remains_restorable() {
        for set in PatchSet::logical_combinations()
            .into_iter()
            .filter(|set| set.contains(PatchId::AdultOnlyTab))
        {
            let r1 = r1_fingerprint(set).expect("historical r1 fingerprint");
            let id = set.id();
            let record = AppliedRecord {
                combination_id: Some(&id),
                revision_id: None,
                patch_version: LEGACY_PATCH_VERSION,
                app_version: r1.app_version,
                status: "APPLIED",
                original_sha256: r1.original_sha256,
                result_sha256: r1.result_sha256,
                backup_sha256: Some(r1.original_sha256),
            };
            let current = CurrentInstall {
                app_version: r1.app_version,
                actual_sha256: r1.result_sha256,
                has_unrecorded_patch_modules: false,
                record: Some(record),
            };
            assert_eq!(
                classify_current(set, current),
                if new_install_allowed(set) {
                    ManagerState::RevisionUpdateAvailable
                } else {
                    ManagerState::Applied
                }
            );
            assert!(can_restore(record, current));
            assert_eq!(
                resolve_registered_revision(
                    set,
                    None,
                    r1.app_version,
                    r1.original_sha256,
                    r1.result_sha256,
                ),
                registered_revisions(set).first().copied()
            );
        }
    }

    #[test]
    fn candidate_requires_the_exact_official_original_fingerprint() {
        let candidate = CandidateManifest {
            original_sha256: "BAD",
            ..manifest("01", PATCH_01_V065_SHA256)
        };
        assert_eq!(verify_candidate(candidate), CandidateCheck::OriginalHashMismatch);
        assert!(!candidate_manager_install_supported(candidate));
    }

    #[test]
    fn candidate_requires_the_exact_verified_result_fingerprint() {
        let candidate = manifest("01", PREVIEW_0123_V065_SHA256);
        assert_eq!(verify_candidate(candidate), CandidateCheck::ResultHashMismatch);
        assert!(!candidate_manager_install_supported(candidate));
    }

    #[test]
    fn candidate_manifest_requires_the_exact_composition_file_list() {
        let candidate = CandidateManifest {
            changed_files: &PATCH_01_CHANGED_FILES[..PATCH_01_CHANGED_FILES.len() - 1],
            ..manifest("01", PATCH_01_V065_SHA256)
        };
        assert_eq!(verify_candidate(candidate), CandidateCheck::ChangedFilesMismatch);
        assert!(!candidate_manager_install_supported(candidate));
    }

    #[test]
    fn unsupported_version_is_rejected_but_verified_preview_subset_is_installable() {
        let wrong_version = CandidateManifest {
            app_version: "0.5.66",
            ..manifest("01", PATCH_01_V065_SHA256)
        };
        assert_eq!(verify_candidate(wrong_version), CandidateCheck::UnsupportedVersion);
        let superseded = manifest("01+02", PATCH_01_02_V065_R2_SHA256);
        assert_eq!(verify_candidate(superseded), CandidateCheck::VerifiedKnownOutput);
        assert!(!candidate_manager_install_supported(superseded));

        let subset = manifest("01+02", PATCH_01_02_V065_R3_SHA256);
        assert_eq!(verify_candidate(subset), CandidateCheck::VerifiedKnownOutput);
        assert!(candidate_manager_install_supported(subset));

        let old_subset = CandidateManifest {
            revision_id: Some("r1"),
            ..manifest("01+02", PATCH_01_02_V065_R1_SHA256)
        };
        assert_eq!(verify_candidate(old_subset), CandidateCheck::VerifiedKnownOutput);
        assert!(!candidate_manager_install_supported(old_subset));
    }

    #[test]
    fn full_preview_fingerprints_remain_verified_but_never_authorize_new_patch03_installs() {
        let preview = manifest("01+02+03", PATCH_01_02_03_V065_R2_SHA256);
        assert_eq!(verify_candidate(preview), CandidateCheck::VerifiedKnownOutput);
        assert!(!candidate_manager_install_supported(preview));
        let legacy = CandidateManifest {
            revision_id: Some("r1"),
            ..manifest("01+02+03", PATCH_01_02_03_V065_R1_SHA256)
        };
        assert_eq!(verify_candidate(legacy), CandidateCheck::VerifiedKnownOutput);
        assert!(!candidate_manager_install_supported(legacy));
    }

    #[test]
    fn historical_patch03_records_remain_detectable_restorable_and_transitionable() {
        for set in PatchSet::logical_combinations()
            .into_iter()
            .filter(|set| !new_install_allowed(*set))
        {
            for revision in registered_revisions(set) {
                let id = set.id();
                let fingerprint = revision.fingerprint;
                let record = AppliedRecord {
                    combination_id: Some(&id),
                    revision_id: Some(revision.id),
                    patch_version: LEGACY_PATCH_VERSION,
                    app_version: fingerprint.app_version,
                    status: "APPLIED",
                    original_sha256: fingerprint.original_sha256,
                    result_sha256: fingerprint.result_sha256,
                    backup_sha256: Some(fingerprint.original_sha256),
                };
                let current = CurrentInstall {
                    app_version: fingerprint.app_version,
                    actual_sha256: fingerprint.result_sha256,
                    has_unrecorded_patch_modules: false,
                    record: Some(record),
                };
                assert_eq!(classify_current(set, current), ManagerState::Applied);
                assert!(can_restore(record, current));
                assert_eq!(classify_current(one(), current), ManagerState::TransitionRequired);
                assert!(resolve_registered_revision(
                    set,
                    Some(revision.id),
                    fingerprint.app_version,
                    fingerprint.original_sha256,
                    fingerprint.result_sha256,
                ).is_some());
            }
        }
    }

    #[test]
    fn revision_catalog_resolves_legacy_and_explicit_revisions_without_guessing() {
        let set = one();
        let fingerprint = combination_capability(set).fingerprint.unwrap();
        let r1 = PatchRevision {
            id: "r1",
            number: 1,
            installable: false,
            fingerprint,
        };
        let r2 = PatchRevision {
            id: "r2",
            number: 2,
            installable: true,
            fingerprint: KnownFingerprint {
                result_sha256: "1111111111111111111111111111111111111111111111111111111111111111",
                evidence: "synthetic unit-test revision only",
                ..fingerprint
            },
        };
        let revisions = [r1, r2];

        assert_eq!(
            resolve_revision_in(
                &revisions,
                None,
                fingerprint.app_version,
                fingerprint.original_sha256,
                fingerprint.result_sha256,
            ),
            Some(r1),
            "legacy record without revision ID must map only from exact registered SHA"
        );
        assert_eq!(
            resolve_revision_in(
                &revisions,
                Some("r2"),
                fingerprint.app_version,
                fingerprint.original_sha256,
                r2.fingerprint.result_sha256,
            ),
            Some(r2)
        );
        assert!(resolve_revision_in(
            &revisions,
            Some("r9"),
            fingerprint.app_version,
            fingerprint.original_sha256,
            r2.fingerprint.result_sha256,
        )
        .is_none());
        assert!(resolve_revision_in(
            &revisions,
            Some("r2"),
            fingerprint.app_version,
            fingerprint.original_sha256,
            fingerprint.result_sha256,
        )
        .is_none());
        assert!(revision_update_available(r1, &revisions));
        assert!(!revision_update_available(r2, &revisions));
    }

    #[test]
    fn candidate_with_unknown_revision_is_rejected() {
        let candidate = CandidateManifest {
            revision_id: Some("r9"),
            ..manifest("01", PATCH_01_V065_SHA256)
        };
        assert_eq!(verify_candidate(candidate), CandidateCheck::UnknownRevision);
        assert!(!candidate_manager_install_supported(candidate));
    }

    #[test]
    fn verified_composition_records_classify_and_restore_only_the_matching_output() {
        for set in PatchSet::logical_combinations() {
            let fingerprint = combination_capability(set).fingerprint.unwrap();
            let id = set.id();
            let record = AppliedRecord {
                combination_id: Some(&id),
                revision_id: None,
                patch_version: LEGACY_PATCH_VERSION,
                app_version: fingerprint.app_version,
                status: "APPLIED",
                original_sha256: fingerprint.original_sha256,
                result_sha256: fingerprint.result_sha256,
                backup_sha256: Some(fingerprint.original_sha256),
            };
            let current = CurrentInstall {
                app_version: fingerprint.app_version,
                actual_sha256: fingerprint.result_sha256,
                has_unrecorded_patch_modules: false,
                record: Some(record),
            };

            assert_eq!(classify_current(set, current), ManagerState::Applied);
            assert!(can_restore(record, current));
            assert_eq!(
                classify_current(one(), current),
                if set == one() {
                    ManagerState::Applied
                } else {
                    ManagerState::TransitionRequired
                }
            );
        }
    }

    #[test]
    fn all_fingerprinted_combinations_preflight_on_the_exact_official_source() {
        for set in PatchSet::logical_combinations() {
            let capability = combination_capability(set);
            let fingerprint = capability.fingerprint.unwrap();
            let id = set.id();
            let candidate = CandidateManifest {
                combination_id: &id,
                revision_id: None,
                app_version: fingerprint.app_version,
                original_sha256: fingerprint.original_sha256,
                result_sha256: fingerprint.result_sha256,
                changed_files: fingerprint.changed_files,
            };
            let install_allowed = new_install_allowed(set);
            assert_eq!(install_preflight(set, candidate, official()), install_allowed, "{}", id);
            assert_eq!(
                classify_current(set, official()),
                if install_allowed { ManagerState::NotApplied } else { ManagerState::UnsupportedCombination },
                "{}",
                id
            );
        }
    }

    #[test]
    fn legacy_01_record_with_combined_bytes_is_a_conflict_and_transition_is_required() {
        let record = legacy_applied();
        let current = CurrentInstall {
            app_version: VERIFIED_APP_VERSION,
            actual_sha256: PREVIEW_0123_V065_SHA256,
            has_unrecorded_patch_modules: true,
            record: Some(record),
        };
        assert_eq!(classify_current(one(), current), ManagerState::Conflict);

        let matching_current = CurrentInstall {
            actual_sha256: PATCH_01_V065_SHA256,
            has_unrecorded_patch_modules: false,
            ..current
        };
        assert_eq!(classify_current(all(), matching_current), ManagerState::TransitionRequired);
    }

    #[test]
    fn combined_modules_without_a_record_remain_unknown_and_blocked() {
        let current = CurrentInstall {
            actual_sha256: PREVIEW_0123_V065_SHA256,
            has_unrecorded_patch_modules: true,
            ..official()
        };
        assert_eq!(classify_current(all(), current), ManagerState::Unknown);
        assert!(!install_preflight(
            all(),
            manifest("01+02+03", PREVIEW_0123_V065_SHA256),
            current
        ));
    }

    #[test]
    fn assessment_does_not_mutate_the_legacy_record_or_backup_reference() {
        let record = legacy_applied();
        let before = record;
        let current = CurrentInstall {
            app_version: VERIFIED_APP_VERSION,
            actual_sha256: PATCH_01_V065_SHA256,
            has_unrecorded_patch_modules: false,
            record: Some(record),
        };
        assert_eq!(classify_current(one(), current), ManagerState::Applied);
        assert_eq!(record, before);
        assert_eq!(record.backup_sha256, Some(OFFICIAL_V065_SHA256));
    }

    #[test]
    fn restore_requires_the_matching_applied_result_and_verified_original_backup() {
        let record = legacy_applied();
        let current = CurrentInstall {
            app_version: VERIFIED_APP_VERSION,
            actual_sha256: PATCH_01_V065_SHA256,
            has_unrecorded_patch_modules: false,
            record: Some(record),
        };
        assert!(can_restore(record, current));

        let mut damaged_backup = record;
        damaged_backup.backup_sha256 = Some("bad");
        assert!(!can_restore(damaged_backup, current));

        let conflicting = CurrentInstall {
            actual_sha256: PREVIEW_0123_V065_SHA256,
            ..current
        };
        assert!(!can_restore(record, conflicting));
    }

    #[test]
    fn invalid_backup_or_unknown_record_fails_closed() {
        let mut record = legacy_applied();
        record.backup_sha256 = Some("bad");
        let current = CurrentInstall {
            actual_sha256: PATCH_01_V065_SHA256,
            record: Some(record),
            ..official()
        };
        assert_eq!(classify_current(one(), current), ManagerState::Unknown);
        assert_eq!(ManagerState::Conflict.label(), "기록과 실제 파일 충돌");
        assert_eq!(ManagerState::TransitionRequired.label(), "조합 전환 필요");
    }

    #[test]
    fn patch_selection_round_trips_all_logical_sets_and_empty() {
        assert_eq!(PatchSelection::DEFAULT.id(), "01");
        assert_eq!(PatchSelection::NONE.id(), "NONE");
        assert_eq!(PatchSelection::parse_id("NONE"), Ok(PatchSelection::NONE));
        for set in PatchSet::logical_combinations() {
            let selection = PatchSelection::parse_id(&set.id()).unwrap();
            assert_eq!(selection.as_patch_set(), Some(set));
            assert_eq!(PatchSelection::parse_id(&selection.id()), Ok(selection));
        }
        assert!(PatchSelection::parse_id("03+01").is_err());
        assert!(PatchSelection::parse_id("01+04").is_err());
    }

    #[test]
    fn patch_selection_install_support_excludes_paused_patch03_compositions() {
        let selection = PatchSelection::DEFAULT
            .with(PatchId::AdultOnlyTab, true)
            .with(PatchId::DoubleSpeedBuffering, true);
        assert_eq!(selection.id(), "01+02+03");
        assert!(selection.contains(PatchId::IntegratedSearchProviderSwitch));
        let set = selection.as_patch_set().expect("selection has a patch set");
        assert_eq!(set.id(), "01+02+03");
        assert!(!selection.manager_install_supported());
        assert!(PatchSelection::from_ids(&[PatchId::AdultOnlyTab]).unwrap().manager_install_supported());
        assert!(PatchSelection::from_ids(&[
            PatchId::IntegratedSearchProviderSwitch,
            PatchId::AdultOnlyTab,
        ]).unwrap().manager_install_supported());
        assert!(PatchSelection::DEFAULT.manager_install_supported());
        assert!(!PatchSelection::NONE.manager_install_supported());
    }
}
