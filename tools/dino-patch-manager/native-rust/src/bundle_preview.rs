//! Offline composition previews from a pinned official ASAR; receipts never authorize installation.
use crate::{asar::{self, Archive}, fail, patch_set::{PatchId, PatchSet}, transaction, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, fs, path::Path};

const OFFICIAL_SHA: &str = "9A5BBCDDDA592F173D6E1C5BC01AC0BBBEC8D003C40CB3A4113AFB307A08DA12";
const COMBINED_FEATURES: [&str; 3] = ["01", "02", "03"];
const APP: &str = include_str!("../../../../src/app.js");
const HTML: &str = include_str!("../../../../src/index.html");
const ADULT_CATALOG_CSS: &str = include_str!("../../../../src/adult-catalog.css");
const ADULT_METADATA_MODULE: &str = include_str!("../../../../electron/adult-catalog-metadata.cjs");
const ADULT_METADATA_MAIN: &str = r#"const { lookupAdultCatalogMetadata } = require('./adult-catalog-metadata.cjs');
ipcMain.handle('adult-catalog:metadata', async (event, items) => {
  if (event.sender !== mainWindow?.webContents) return { available: false, requested: 0, records: [] };
  return lookupAdultCatalogMetadata(items, (query, variables, options) => anilist(query, variables, options));
});
"#;
const ADULT_METADATA_PRELOAD: &str =
    "  adultCatalogMetadata: items => ipcRenderer.invoke('adult-catalog:metadata', items),\n";
const RECEIPT_SCHEMA_VERSION: u64 = 2;

fn unique(text: &str, anchor: &str) -> Result<usize> {
    let mut matches = text.match_indices(anchor);
    match (matches.next(), matches.next()) {
        (Some((index, _)), None) => Ok(index),
        _ => Err(fail(format!("공식 연결 지점이 없거나 중복됩니다: {anchor}"))),
    }
}

fn section<'a>(text: &'a str, start: &str, end: &str) -> Result<&'a str> {
    let start = unique(text, start)?;
    let end = unique(text, end)?;
    text.get(start..end).ok_or_else(|| fail("패치 소스 범위가 올바르지 않습니다."))
}

fn insert(text: &mut String, anchor: &str, payload: &str) -> Result<()> {
    let index = unique(text, anchor)?;
    text.insert_str(index, payload);
    Ok(())
}

fn sha256_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02X}")).collect()
}

fn revision_id(set: PatchSet, changed_files: &BTreeMap<String, Vec<u8>>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"dino-patch-preview-revision-v1\n");
    hasher.update(format!("source-version=0.5.65\nsource-sha256={OFFICIAL_SHA}\ncomposition={}\n", set.id()));
    for (path, bytes) in changed_files {
        let file_sha = sha256_bytes(bytes);
        hasher.update(format!("{}:{path}:{file_sha}\n", path.len()));
    }
    let digest: String = hasher.finalize().iter().map(|byte| format!("{byte:02X}")).collect();
    format!("sha256:{digest}")
}

fn changed_file_hashes(changed_files: &BTreeMap<String, Vec<u8>>) -> Vec<Value> {
    changed_files.iter().map(|(path, bytes)| json!({
        "path": path,
        "sha256": sha256_bytes(bytes)
    })).collect()
}

fn registered_revision(set: PatchSet, output_sha256: &str) -> Option<Value> {
    crate::patch_set::registered_revisions(set)
        .into_iter()
        .find(|revision| output_sha256.eq_ignore_ascii_case(revision.fingerprint.result_sha256))
        .map(|revision| json!({
            "label": revision.id,
            "classification": if revision.number == 1 { "REGISTERED_LEGACY" } else { "REGISTERED_VERIFIED" },
            "evidence": revision.fingerprint.evidence
        }))
}

fn connect_adult_detail_controls(app: &mut String) -> Result<()> {
    insert(
        app,
        "    $('#detailContent').innerHTML=`<div class=\"detail-hero\"",
        "    const adultIdentity=adultCatalogIdentity(a);\n    const adultManual=adultIdentity?readAdultCatalogOverrides(store).get(adultIdentity.workKey)||null:null;\n    const adultClassification=adultIdentity?classifyAdultCatalogItem(a,{verifiedMetadata:readAdultCatalogMetadata(),manual:adultManual}):null;\n    const adultPanel=adultIdentity?adultClassificationPanelMarkup(a,adultClassification,adultManual):'';\n",
    )?;
    insert(app, "<p class=\"detail-synopsis\"", "${adultPanel}")?;
    insert(
        app,
        "    if(art?.banner)applyDetailArtwork(",
        "    if(adultIdentity)bindAdultClassificationControls(a,token);\n",
    )?;
    Ok(())
}

fn add_adult_catalog_stylesheet(
    html: &mut String,
    changes: &mut BTreeMap<String, Vec<u8>>,
) -> Result<()> {
    if html.contains("adult-catalog.css") || changes.contains_key("src/adult-catalog.css") {
        return Err(fail("야애니 분류 스타일이 이미 연결되어 있습니다."));
    }
    insert(
        html,
        "</head>",
        "  <link rel=\"stylesheet\" href=\"adult-catalog.css\" />\n",
    )?;
    if ADULT_CATALOG_CSS.trim().is_empty() {
        return Err(fail("야애니 분류 스타일 파일이 비어 있습니다."));
    }
    changes.insert(
        "src/adult-catalog.css".into(),
        ADULT_CATALOG_CSS.as_bytes().to_vec(),
    );
    Ok(())
}

fn add_adult_metadata_bridge(
    main: &mut String,
    preload: &mut String,
    changes: &mut BTreeMap<String, Vec<u8>>,
) -> Result<()> {
    if main.contains("adult-catalog:metadata") || preload.contains("adultCatalogMetadata")
        || changes.contains_key("electron/adult-catalog-metadata.cjs") {
        return Err(fail("야애니 메타데이터 IPC가 이미 연결되어 있습니다."));
    }
    if !main.contains("createAnilistClient") || !main.contains("const anilist =") || !main.contains("mainWindow") {
        return Err(fail("공식 AniList 클라이언트 또는 메인 창 연결을 확인할 수 없습니다."));
    }
    insert(main, "ipcMain.handle('provider:catalog'", ADULT_METADATA_MAIN)?;
    insert(preload, "  providerCatalog:", ADULT_METADATA_PRELOAD)?;
    changes.insert(
        "electron/adult-catalog-metadata.cjs".into(),
        ADULT_METADATA_MODULE.as_bytes().to_vec(),
    );
    Ok(())
}

fn add_adult_catalog(html: &mut String, app: &mut String) -> Result<()> {
    if html.contains("adultCatalog") || app.contains("adultCatalog") {
        return Err(fail("야애니 탭 연결이 이미 존재합니다."));
    }
    insert(html, "        <button class=\"nav\" data-view=\"search\"", section(
        HTML, "        <button class=\"nav\" data-view=\"adultCatalog\"", "        <button class=\"nav\" data-view=\"history\"",
    )?)?;
    insert(html, "      <section id=\"historyView\"", section(
        HTML, "      <section id=\"adultCatalogView\"", "      <section id=\"historyView\"",
    )?)?;
    let catalog = section(APP, "const adultCatalog=", "function toggleLibrary(")?
        .replace("normalizeSearchText(", "normalizeAdultCatalogText(");
    insert(app, "function toggleLibrary(", &format!(
        "function normalizeAdultCatalogText(value) {{ return String(value || '').normalize('NFKC').toLowerCase().trim(); }}\n{catalog}"
    ))?;
    connect_adult_detail_controls(app)?;
    insert(app, "  if(name==='player'&&current&&current!=='player')",
        "  if(current==='adultCatalog' && name!==current) adultCatalog.scrollTop=main.scrollTop;\n")?;
    insert(app, "  if (name === 'history') renderHistory();",
        "  if(name==='adultCatalog'){main.scrollTop=adultCatalog.scrollTop;if(!adultCatalog.started)void loadAdultCatalogPage();return;}\n")?;

    Ok(())
}

fn add_fast_buffer(app: &mut String) -> Result<()> {
    if app.contains("updateFastHlsBuffer") {
        return Err(fail("2배속 버퍼 최적화 연결이 이미 존재합니다."));
    }
    insert(app, "function play(src,", section(APP, "function updateFastHlsBuffer(", "function bindHlsPlayerEvents(")?)?;
    insert(app, "    hlsPlayer.on(Hls.Events.MANIFEST_PARSED,",
        "    const fastBufferPlayer=hlsPlayer;\n    fastBufferPlayer.on(Hls.Events.LEVEL_LOADED,()=>{if(hlsPlayer===fastBufferPlayer)updateFastHlsBuffer(fastBufferPlayer,video.playbackRate);});\n")?;
    insert(app, "$('#speed').onchange=",
        "$('#video').addEventListener('ratechange',event=>updateFastHlsBuffer(hlsPlayer,event.currentTarget.playbackRate));\n")?;

    Ok(())
}

fn add_selected_features(
    set: PatchSet,
    mut changes: BTreeMap<String, Vec<u8>>,
) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut html = String::from_utf8(changes.remove("src/index.html").ok_or_else(|| fail("선택 조합 HTML 누락"))?)?;
    let mut app = String::from_utf8(changes.remove("src/app.js").ok_or_else(|| fail("선택 조합 렌더러 누락"))?)?;

    if set.contains(PatchId::AdultOnlyTab) {
        add_adult_catalog(&mut html, &mut app)?;
        add_adult_catalog_stylesheet(&mut html, &mut changes)?;
        let mut main = String::from_utf8(changes.remove("electron/main.cjs")
            .ok_or_else(|| fail("선택 조합 main 프로세스 누락"))?)?;
        let mut preload = String::from_utf8(changes.remove("electron/preload.cjs")
            .ok_or_else(|| fail("선택 조합 preload 누락"))?)?;
        add_adult_metadata_bridge(&mut main, &mut preload, &mut changes)?;
        changes.insert("electron/main.cjs".into(), main.into_bytes());
        changes.insert("electron/preload.cjs".into(), preload.into_bytes());
    }
    if set.contains(PatchId::DoubleSpeedBuffering) {
        add_fast_buffer(&mut app)?;
    }

    changes.insert("src/index.html".into(), html.into_bytes());
    changes.insert("src/app.js".into(), app.into_bytes());
    Ok(changes)
}

pub(crate) fn compose_selection(archive: &Archive, set: PatchSet) -> Result<BTreeMap<String, Vec<u8>>> {
    if set.contains(PatchId::AdultOnlyTab)
        && archive.files().contains(&"electron/adult-catalog-metadata.cjs") {
        return Err(fail("공식 원본에 야애니 메타데이터 모듈이 이미 있어 덮어쓸 수 없습니다."));
    }
    let mut changes = if set.contains(PatchId::IntegratedSearchProviderSwitch) {
        transaction::replacements(archive, "0.5.65")?
    } else {
        BTreeMap::new()
    };
    let mut required_paths = vec!["src/app.js", "src/index.html"];
    if set.contains(PatchId::AdultOnlyTab) {
        required_paths.extend(["electron/main.cjs", "electron/preload.cjs"]);
    }
    for path in required_paths {
        if !changes.contains_key(path) {
            changes.insert(path.to_owned(), archive.read(path)?);
        }
    }
    add_selected_features(set, changes)
}

pub fn export(input: &Path, output: &Path) -> Result<Value> {
    let set = PatchSet::from_ids(&PatchId::ALL)?;
    export_selection(input, set, output)
}

pub fn export_selection(input: &Path, set: PatchSet, output: &Path) -> Result<Value> {
    if transaction::sha(input)? != OFFICIAL_SHA {
        return Err(fail("공식 v0.5.65 원본 ASAR SHA-256이 일치하지 않습니다."));
    }
    let parent = output.parent().filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| fail("새 검증 폴더의 절대 경로를 지정하세요."))?;
    if !output.is_absolute() {
        return Err(fail("새 검증 폴더의 절대 경로를 지정하세요."));
    }
    asar::dir_only(parent)?;
    fs::create_dir(output)?;
    let original = output.join("original.asar");
    fs::copy(input, &original)?;
    if transaction::sha(&original)? != OFFICIAL_SHA {
        return Err(fail("원본 복사본의 SHA-256이 일치하지 않습니다."));
    }
    let archive = Archive::open(&original)?;
    transaction::verify_identity(&archive, "0.5.65")?;
    let changes = compose_selection(&archive, set)?;
    let staged = output.join("combined.asar.pending");
    archive.write_modified(&staged, &changes)?;
    let patched = Archive::open(&staged)?;
    for (name, expected) in &changes {
        if patched.read(name)? != *expected {
            return Err(fail(format!("내보낸 ASAR 데이터 불일치: {name}")));
        }
    }
    let patched_sha = transaction::sha(&staged)?;
    drop(patched);
    fs::rename(&staged, output.join("combined.asar"))?;
    let composition_id = set.id();
    let features: Vec<&str> = PatchId::ALL.into_iter()
        .filter(|id| set.contains(*id))
        .map(PatchId::code)
        .collect();
    let registered = registered_revision(set, &patched_sha);
    let revision = json!({
        "id": revision_id(set, &changes),
        "registered": registered.is_some(),
        "legacyRevision": registered.as_ref().and_then(|value| value["label"].as_str()),
        "classification": registered.as_ref().and_then(|value| value["classification"].as_str()).unwrap_or("UNREGISTERED_PREVIEW"),
        "evidence": registered.as_ref().and_then(|value| value["evidence"].as_str()),
        "changedFileHashes": changed_file_hashes(&changes)
    });
    let receipt = json!({
        "receiptSchemaVersion": RECEIPT_SCHEMA_VERSION,
        "status":"EXPORTED", "version":"0.5.65", "compositionId":composition_id,
        "features":features, "installable":false,
        "originalSha256":OFFICIAL_SHA, "combinedSha256":patched_sha,
        "changedFiles":changes.keys().collect::<Vec<_>>(),
        "revision": revision
    });
    fs::write(output.join("receipt.json"), serde_json::to_vec_pretty(&receipt)?)?;
    Ok(receipt)
}

fn receipt_schema(receipt: &Value) -> Result<u64> {
    match receipt.get("receiptSchemaVersion") {
        None => Ok(1),
        Some(value) => match value.as_u64() {
            Some(schema @ (1 | RECEIPT_SCHEMA_VERSION)) => Ok(schema),
            _ => Err(fail("통합 ASAR 기록 스키마 버전이 잘못됐습니다.")),
        },
    }
}

fn receipt_set(receipt: &Value) -> Result<PatchSet> {
    let schema = receipt_schema(receipt)?;
    if receipt["status"] != "EXPORTED" || receipt["version"] != "0.5.65"
        || receipt["originalSha256"] != OFFICIAL_SHA
        || !matches!(schema, 1 | RECEIPT_SCHEMA_VERSION)
        || (schema == RECEIPT_SCHEMA_VERSION && receipt.get("installable") != Some(&Value::Bool(false)))
        || receipt.get("installable").is_some_and(|value| value != &Value::Bool(false)) {
        return Err(fail("지원되지 않는 통합 ASAR 기록입니다."));
    }
    let features = receipt["features"].as_array().ok_or_else(|| fail("프리뷰 기능 목록이 없습니다."))?;
    let codes = features.iter().map(|feature| feature.as_str()
        .ok_or_else(|| fail("프리뷰 기능 ID가 잘못됐습니다.")))
        .collect::<Result<Vec<_>>>()?;
    let parsed = PatchSet::parse_id(&codes.join("+"))
        .map_err(|error| fail(error))?;
    let expected: Vec<&str> = PatchId::ALL.into_iter()
        .filter(|id| parsed.contains(*id))
        .map(PatchId::code)
        .collect();
    let parsed_id = parsed.id();
    let composition_id_matches = receipt.get("compositionId")
        .is_none_or(|value| value.as_str() == Some(parsed_id.as_str()));
    if codes != expected || !composition_id_matches {
        return Err(fail("프리뷰 기능과 조합 ID가 일치하지 않습니다."));
    }
    Ok(parsed)
}

fn validate_revision_receipt(receipt: &Value, set: PatchSet, archive: &Archive, digest: &str) -> Result<()> {
    let schema = receipt_schema(receipt)?;
    if schema == 1 {
        return Ok(());
    }
    let revision = receipt.get("revision").ok_or_else(|| fail("패치 개정판 기록이 없습니다."))?;
    let revision_id_expected = revision["id"].as_str()
        .filter(|value| value.starts_with("sha256:") && value.len() == 71
            && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| fail("패치 개정판 ID 형식이 잘못됐습니다."))?;
    let path_values = receipt["changedFiles"].as_array()
        .ok_or_else(|| fail("변경 파일 목록이 없습니다."))?;
    let digest_values = revision["changedFileHashes"].as_array()
        .ok_or_else(|| fail("변경 파일 지문 목록이 없습니다."))?;
    if path_values.len() != digest_values.len() || path_values.is_empty() {
        return Err(fail("패치 개정판 파일 목록이 서로 일치하지 않습니다."));
    }

    let mut changed = BTreeMap::new();
    let mut previous: Option<String> = None;
    for (path_value, digest_value) in path_values.iter().zip(digest_values) {
        let path = path_value.as_str().ok_or_else(|| fail("변경 파일 경로가 잘못됐습니다."))?;
        let file_sha = digest_value["sha256"].as_str()
            .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| fail("변경 파일 SHA-256 형식이 잘못됐습니다."))?;
        if digest_value["path"] != path || path.is_empty() || path.contains('\\')
            || path.split('/').any(|part| part.is_empty() || part == "." || part == "..")
            || previous.as_deref().is_some_and(|value| value >= path) {
            return Err(fail("개정판 경로 목록이 잘못됐거나 정렬되지 않았습니다."));
        }
        let bytes = archive.read(path)?;
        if !sha256_bytes(&bytes).eq_ignore_ascii_case(file_sha) {
            return Err(fail(format!("개정판 파일 지문이 다릅니다: {path}")));
        }
        previous = Some(path.to_owned());
        changed.insert(path.to_owned(), bytes);
    }

    if revision_id_expected != revision_id(set, &changed) {
        return Err(fail("패치 개정판 ID가 파일 지문과 다릅니다."));
    }
    let registered = registered_revision(set, digest);
    let expected_label = registered.as_ref().and_then(|value| value["label"].as_str());
    let expected_classification = registered.as_ref().and_then(|value| value["classification"].as_str())
        .unwrap_or("UNREGISTERED_PREVIEW");
    if revision["legacyRevision"].as_str() != expected_label
        || revision["classification"] != expected_classification
        || revision["registered"].as_bool() != Some(registered.is_some())
        || revision["evidence"].as_str() != registered.as_ref().and_then(|value| value["evidence"].as_str()) {
        return Err(fail(format!("조합 {}의 등록 개정판 표기가 결과 지문과 다릅니다.", set.id())));
    }
    Ok(())
}

fn validate_selection_receipt(
    receipt: &Value,
    set: PatchSet,
    original: &Archive,
    combined: &Archive,
    digest: &str,
) -> Result<()> {
    if receipt_schema(receipt)? != RECEIPT_SCHEMA_VERSION {
        return Ok(());
    }
    transaction::verify_identity(original, "0.5.65")?;
    let recorded_paths: Vec<&str> = receipt["changedFiles"].as_array()
        .ok_or_else(|| fail("변경 파일 목록이 없습니다."))?
        .iter()
        .map(|value| value.as_str().ok_or_else(|| fail("변경 파일 경로가 잘못됐습니다.")))
        .collect::<Result<Vec<_>>>()?;

    // A registered historical receipt must be checked against its pinned
    // revision manifest. Re-composing it with today's source would silently
    // make legitimate r1 receipts unreadable after an r2 update.
    let registered = crate::patch_set::registered_revisions(set)
        .into_iter()
        .find(|revision| digest.eq_ignore_ascii_case(revision.fingerprint.result_sha256));
    let latest = crate::patch_set::latest_installable_revision(set);
    if let (Some(revision), Some(latest)) = (registered, latest) {
        if revision.number < latest.number {
            let expected_paths = revision.fingerprint.changed_files;
            if recorded_paths != expected_paths {
                return Err(fail("기록된 변경 파일이 등록된 과거 개정판과 다릅니다."));
            }
            let mut expected_entries: BTreeSet<String> = original.files().into_iter().map(str::to_owned).collect();
            expected_entries.extend(expected_paths.iter().map(|path| (*path).to_owned()));
            let combined_entries: BTreeSet<String> = combined.files().into_iter().map(str::to_owned).collect();
            if combined_entries != expected_entries {
                return Err(fail("과거 개정판 ASAR 내부 파일 구성이 등록된 매니페스트와 다릅니다."));
            }
            return Ok(());
        }
    }

    let expected_changes = compose_selection(original, set)?;
    let expected_paths: Vec<&str> = expected_changes.keys().map(String::as_str).collect();
    if recorded_paths != expected_paths {
        return Err(fail("기록된 변경 파일이 선택 조합의 구성 파일과 다릅니다."));
    }
    for (path, expected) in &expected_changes {
        if combined.read(path)? != *expected {
            return Err(fail(format!("선택 조합 파일이 생성 결과와 다릅니다: {path}")));
        }
    }
    let mut expected_entries: BTreeSet<String> = original.files().into_iter().map(str::to_owned).collect();
    expected_entries.extend(expected_changes.keys().cloned());
    let combined_entries: BTreeSet<String> = combined.files().into_iter().map(str::to_owned).collect();
    if combined_entries != expected_entries {
        return Err(fail("ASAR 내부 파일 구성이 선택 조합의 예상과 다릅니다."));
    }
    Ok(())
}

fn receipt_digest(receipt: &Value) -> Result<&str> {
    let _set = receipt_set(receipt)?;
    let digest = receipt["combinedSha256"].as_str()
        .filter(|hash| hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_digit() || (b'A'..=b'F').contains(&c)))
        .ok_or_else(|| fail("통합 ASAR 지문 형식이 잘못됐습니다."))?;
    if digest == OFFICIAL_SHA {
        return Err(fail("통합 ASAR 지문이 공식 원본과 같습니다."));
    }
    Ok(digest)
}

/// Receipt consistency only. A receipt is not trusted install authorization.
pub fn verify_export(directory: &Path) -> Result<Value> {
    asar::dir_only(directory)?;
    let record = directory.join("receipt.json");
    if asar::file_only(&record)?.len() > 16 * 1024 {
        return Err(fail("통합 ASAR 기록 크기가 제한을 초과했습니다."));
    }
    let receipt: Value = serde_json::from_slice(&fs::read(&record)?)?;
    let set = receipt_set(&receipt)?;
    let digest = receipt_digest(&receipt)?;
    let original_path = directory.join("original.asar");
    let combined_path = directory.join("combined.asar");
    if transaction::sha(&original_path)? != OFFICIAL_SHA || transaction::sha(&combined_path)? != digest {
        return Err(fail("통합 ASAR 또는 원본 복사본의 지문이 기록과 다릅니다."));
    }
    let original = Archive::open(&original_path)?;
    let archive = Archive::open(&combined_path)?;
    validate_revision_receipt(&receipt, set, &archive, digest)?;
    validate_selection_receipt(&receipt, set, &original, &archive, digest)?;
    Ok(json!({
        "status":"PREVIEW_HASHES_MATCH", "installable":false,
        "compositionId":set.id(),
        "features":PatchId::ALL.into_iter().filter(|id| set.contains(*id)).map(PatchId::code).collect::<Vec<_>>(),
        "originalSha256":OFFICIAL_SHA, "combinedSha256":digest
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_receipt_accepts_valid_selections_but_never_authorizes_install() {
        let mut receipt = json!({
            "status":"EXPORTED", "version":"0.5.65", "compositionId":"01+02+03",
            "features":COMBINED_FEATURES, "installable":false,
            "originalSha256":OFFICIAL_SHA, "combinedSha256":"A".repeat(64)
        });
        assert_eq!(receipt_set(&receipt).unwrap().id(), "01+02+03");
        assert!(receipt_digest(&receipt).is_ok());
        for (id, features) in [
            ("01", json!(["01"])),
            ("02", json!(["02"])),
            ("03", json!(["03"])),
            ("01+02", json!(["01", "02"])),
            ("01+03", json!(["01", "03"])),
            ("02+03", json!(["02", "03"])),
            ("01+02+03", json!(["01", "02", "03"])),
        ] {
            receipt["compositionId"] = json!(id);
            receipt["features"] = features;
            assert_eq!(receipt_set(&receipt).unwrap().id(), id);
            assert!(receipt_digest(&receipt).is_ok());
        }
        receipt["features"] = json!(COMBINED_FEATURES);
        receipt["compositionId"] = json!("01");
        assert!(receipt_digest(&receipt).is_err());
        receipt["compositionId"] = json!("01+02+03");
        for features in [json!([]), json!(["01", "02", "02"]), json!(["01", "02", "04"]), json!(["02", "01"])] {
            receipt["features"] = features;
            assert!(receipt_digest(&receipt).is_err());
        }
        receipt["features"] = json!(COMBINED_FEATURES);
        receipt["installable"] = json!(true);
        assert!(receipt_digest(&receipt).is_err());
        receipt["installable"] = json!(false);
        receipt["installable"] = json!("false");
        assert!(receipt_digest(&receipt).is_err());
        receipt["installable"] = json!(false);
        for digest in ["wrong", OFFICIAL_SHA] {
            receipt["combinedSha256"] = json!(digest);
            assert!(receipt_digest(&receipt).is_err());
        }
    }

    #[test]
    fn connection_requires_exactly_one_anchor() {
        for input in ["missing", "anchor anchor"] {
            let mut input = input.to_owned();
            assert!(insert(&mut input, "anchor", "patch").is_err());
        }
        let mut input = "anchor".to_owned();
        insert(&mut input, "anchor", "patch ").unwrap();
        assert_eq!(input, "patch anchor");
    }

    #[test]
    fn revision_identity_is_stable_and_changes_with_any_packaged_file() {
        let set = PatchSet::parse_id("01+02+03").unwrap();
        let original = BTreeMap::from([
            ("src/app.js".to_owned(), b"patched app".to_vec()),
            ("src/index.html".to_owned(), b"patched html".to_vec()),
        ]);
        let reordered = BTreeMap::from([
            ("src/index.html".to_owned(), b"patched html".to_vec()),
            ("src/app.js".to_owned(), b"patched app".to_vec()),
        ]);
        let modified = BTreeMap::from([
            ("src/app.js".to_owned(), b"patched app v2".to_vec()),
            ("src/index.html".to_owned(), b"patched html".to_vec()),
        ]);
        assert_eq!(revision_id(set, &original), revision_id(set, &reordered));
        assert_ne!(revision_id(set, &original), revision_id(set, &modified));
        assert!(revision_id(set, &original).starts_with("sha256:"));
    }

    #[test]
    fn exact_registered_outputs_receive_their_revision_labels_without_authorizing_receipts() {
        let set = PatchSet::parse_id("01+02+03").unwrap();
        let revisions = crate::patch_set::registered_revisions(set);
        let r1 = revisions.iter().find(|revision| revision.id == "r1").unwrap();
        let r1_receipt = registered_revision(set, r1.fingerprint.result_sha256).unwrap();
        assert_eq!(r1_receipt["label"], "r1");
        assert_eq!(r1_receipt["classification"], "REGISTERED_LEGACY");
        let r2 = revisions.iter().find(|revision| revision.id == "r2").unwrap();
        let r2_receipt = registered_revision(set, r2.fingerprint.result_sha256).unwrap();
        assert_eq!(r2_receipt["label"], "r2");
        assert_eq!(r2_receipt["classification"], "REGISTERED_VERIFIED");
        assert!(registered_revision(set, &"A".repeat(64)).is_none());

        for (selected, expected_id, expected_sha) in [
            (
                PatchSet::parse_id("02").unwrap(),
                "r3",
                crate::patch_set::PATCH_02_V065_R3_SHA256,
            ),
            (
                PatchSet::parse_id("01+02").unwrap(),
                "r3",
                crate::patch_set::PATCH_01_02_V065_R3_SHA256,
            ),
        ] {
            let r3_receipt = registered_revision(selected, expected_sha).unwrap();
            assert_eq!(r3_receipt["label"], expected_id);
            assert_eq!(r3_receipt["classification"], "REGISTERED_VERIFIED");
        }
    }

    #[test]
    fn old_receipts_remain_readable_while_new_revision_receipts_must_be_explicitly_noninstallable() {
        let mut old = json!({
            "status":"EXPORTED", "version":"0.5.65", "compositionId":"01",
            "features":["01"], "originalSha256":OFFICIAL_SHA,
            "combinedSha256":"A".repeat(64)
        });
        assert_eq!(receipt_set(&old).unwrap().id(), "01");
        old["receiptSchemaVersion"] = json!(RECEIPT_SCHEMA_VERSION);
        old["installable"] = json!(false);
        assert!(receipt_set(&old).is_ok());
        old.as_object_mut().unwrap().remove("installable");
        assert!(receipt_set(&old).is_err());
        old["installable"] = json!(false);
        old["installable"] = json!(true);
        assert!(receipt_set(&old).is_err());
        old["installable"] = json!(false);
        old["receiptSchemaVersion"] = json!(3);
        assert!(receipt_set(&old).is_err());
        old["receiptSchemaVersion"] = json!("2");
        assert!(receipt_set(&old).is_err());
    }

    #[test]
    fn selected_adult_and_buffer_transforms_compose_without_claiming_installability() {
        let mut html = "</head>\n        <button class=\"nav\" data-view=\"search\"\n      <section id=\"historyView\"".to_owned();
        let mut app = "function toggleLibrary(\n  if(name==='player'&&current&&current!=='player')\n  if (name === 'history') renderHistory();\n    $('#detailContent').innerHTML=`<div class=\"detail-hero\"<p class=\"detail-synopsis\"\n    if(art?.banner)applyDetailArtwork(\nfunction play(src,\n    hlsPlayer.on(Hls.Events.MANIFEST_PARSED,\n$('#speed').onchange=".to_owned();
        let mut main = "const { createAnilistClient } = require('./anilist-client.cjs');\nconst anilist = createAnilistClient({});\nlet mainWindow = null;\nipcMain.handle('provider:catalog',".to_owned();
        let mut preload = "  providerCatalog:".to_owned();
        let mut changes = BTreeMap::new();

        add_adult_catalog(&mut html, &mut app).unwrap();
        add_adult_catalog_stylesheet(&mut html, &mut changes).unwrap();
        add_adult_metadata_bridge(&mut main, &mut preload, &mut changes).unwrap();
        add_fast_buffer(&mut app).unwrap();

        assert!(html.contains("data-view=\"adultCatalog\""));
        assert!(html.contains("adult-catalog.css"));
        assert!(app.contains("adultCatalog"));
        assert!(app.contains("bindAdultClassificationControls"));
        assert!(app.contains("updateFastHlsBuffer"));
        assert!(app.contains("Hls.Events.LEVEL_LOADED"));
        assert!(app.contains("playbackRate"));
        assert!(main.contains("adult-catalog:metadata"));
        assert!(preload.contains("adultCatalogMetadata"));
        assert_eq!(changes["electron/adult-catalog-metadata.cjs"], ADULT_METADATA_MODULE.as_bytes());

        assert!(add_adult_catalog(&mut html, &mut app).is_err());
        assert!(add_adult_metadata_bridge(&mut main, &mut preload, &mut changes).is_err());
        assert!(add_fast_buffer(&mut app).is_err());
    }

    #[test]
    fn each_logical_selection_adds_only_the_selected_offline_preview_features() {
        use crate::patch_set::{PatchId, PatchSet};

        let base_changes = || {
            BTreeMap::from([
                (
                    "src/index.html".to_owned(),
                    b"        <button class=\"nav\" data-view=\"search\"\n      <section id=\"historyView\"\n</head>".to_vec(),
                ),
                (
                    "src/app.js".to_owned(),
                    b"function toggleLibrary(\n  if(name==='player'&&current&&current!=='player')\n  if (name === 'history') renderHistory();\n    $('#detailContent').innerHTML=`<div class=\"detail-hero\"<p class=\"detail-synopsis\"\n    if(art?.banner)applyDetailArtwork(\nfunction play(src,\n    hlsPlayer.on(Hls.Events.MANIFEST_PARSED,\n$('#speed').onchange=".to_vec(),
                ),
            ])
        };

        for set in PatchSet::logical_combinations() {
            let mut base = base_changes();
            if set.contains(PatchId::IntegratedSearchProviderSwitch) {
                base.insert("src/integrated-search.js".to_owned(), b"01 module".to_vec());
            }
            if set.contains(PatchId::AdultOnlyTab) || set.contains(PatchId::IntegratedSearchProviderSwitch) {
                base.insert("electron/main.cjs".to_owned(), b"const { createAnilistClient } = require('./anilist-client.cjs');\nconst anilist = createAnilistClient({});\nlet mainWindow = null;\nipcMain.handle('provider:catalog',".to_vec());
                base.insert("electron/preload.cjs".to_owned(), b"  providerCatalog:".to_vec());
            }
            let changes = add_selected_features(set, base).unwrap();
            let html = String::from_utf8(changes["src/index.html"].clone()).unwrap();
            let app = String::from_utf8(changes["src/app.js"].clone()).unwrap();
            let adult = set.contains(PatchId::AdultOnlyTab);
            let fast = set.contains(PatchId::DoubleSpeedBuffering);

            assert_eq!(html.contains("adult-catalog.css"), adult, "{}", set.id());
            assert_eq!(app.contains("adultCatalog"), adult, "{}", set.id());
            assert_eq!(app.contains("updateFastHlsBuffer"), fast, "{}", set.id());
            assert_eq!(changes.contains_key("src/adult-catalog.css"), adult, "{}", set.id());
            assert_eq!(changes.contains_key("electron/adult-catalog-metadata.cjs"), adult, "{}", set.id());
            assert_eq!(changes.contains_key("electron/main.cjs"), adult || set.contains(PatchId::IntegratedSearchProviderSwitch), "{}", set.id());
            assert_eq!(changes.contains_key("electron/preload.cjs"), adult || set.contains(PatchId::IntegratedSearchProviderSwitch), "{}", set.id());
            if adult {
                assert!(String::from_utf8(changes["electron/main.cjs"].clone()).unwrap().contains("adult-catalog:metadata"));
                assert!(String::from_utf8(changes["electron/preload.cjs"].clone()).unwrap().contains("adultCatalogMetadata"));
            }
            assert_eq!(
                changes.keys().any(|path| path == "src/integrated-search.js"),
                set.contains(PatchId::IntegratedSearchProviderSwitch),
                "{}",
                set.id()
            );
        }
    }

    #[test]
    fn combined_catalog_connects_detail_override_actions() {
        let mut app = "    $('#detailContent').innerHTML=`<div class=\"detail-hero\"></div><p class=\"detail-synopsis\"></p>`;\n    if(art?.banner)applyDetailArtwork(".to_owned();
        connect_adult_detail_controls(&mut app).unwrap();
        assert!(app.contains("const adultIdentity=adultCatalogIdentity(a)"));
        assert!(app.contains("${adultPanel}<p class=\"detail-synopsis\""));
        assert!(app.contains("if(adultIdentity)bindAdultClassificationControls(a,token)"));

        let catalog = section(APP, "const adultCatalog=", "function toggleLibrary(").unwrap();
        for marker in [
            "dinoAdultCatalogOverrides",
            "야애니로 지정",
            "야애니에서 제외",
            "자동 분류로 복귀",
            "hydrateAdultCatalogManualEntries",
        ] {
            assert!(catalog.contains(marker), "missing current catalog source: {marker}");
        }
    }

    #[test]
    fn combined_catalog_links_its_packaged_stylesheet() {
        let mut html = "<html><head></head><body></body></html>".to_owned();
        let mut changes = BTreeMap::new();
        add_adult_catalog_stylesheet(&mut html, &mut changes).unwrap();
        assert!(html.contains("<link rel=\"stylesheet\" href=\"adult-catalog.css\" />"));
        assert_eq!(changes.get("src/adult-catalog.css").unwrap(), ADULT_CATALOG_CSS.as_bytes());
        assert!(add_adult_catalog_stylesheet(&mut html, &mut changes).is_err());
    }

    #[test]
    fn combined_adult_tab_follows_all_and_preserves_existing_search() {
        let mut nav = "        <button class=\"nav\" data-view=\"all\"></button>\n        <button class=\"nav\" data-view=\"search\"></button>\n        <button class=\"nav\" data-view=\"history\"></button>".to_owned();
        let adult_nav = section(
            HTML,
            "        <button class=\"nav\" data-view=\"adultCatalog\"",
            "        <button class=\"nav\" data-view=\"history\"",
        )
        .unwrap();
        insert(&mut nav, "        <button class=\"nav\" data-view=\"search\"", adult_nav)
            .unwrap();
        let all = nav.find("data-view=\"all\"").unwrap();
        let adult = nav.find("data-view=\"adultCatalog\"").unwrap();
        let search = nav.find("data-view=\"search\"").unwrap();
        let history = nav.find("data-view=\"history\"").unwrap();
        assert!(all < adult && adult < search && search < history);
    }
}
