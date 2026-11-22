//! Offline composition previews from a pinned official ASAR; receipts never authorize installation.
use crate::{asar::{self, Archive}, fail, patch_set::{PatchId, PatchSet}, transaction, Result};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::Path};

const OFFICIAL_SHA: &str = "9A5BBCDDDA592F173D6E1C5BC01AC0BBBEC8D003C40CB3A4113AFB307A08DA12";
const COMBINED_FEATURES: [&str; 3] = ["01", "02", "03"];
const APP: &str = include_str!("../../../../src/app.js");
const HTML: &str = include_str!("../../../../src/index.html");
const ADULT_CATALOG_CSS: &str = include_str!("../../../../src/adult-catalog.css");

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
    }
    if set.contains(PatchId::DoubleSpeedBuffering) {
        add_fast_buffer(&mut app)?;
    }

    changes.insert("src/index.html".into(), html.into_bytes());
    changes.insert("src/app.js".into(), app.into_bytes());
    Ok(changes)
}

pub(crate) fn compose_selection(archive: &Archive, set: PatchSet) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut changes = if set.contains(PatchId::IntegratedSearchProviderSwitch) {
        transaction::replacements(archive, "0.5.65")?
    } else {
        BTreeMap::new()
    };
    for path in ["src/app.js", "src/index.html"] {
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
    let receipt = json!({
        "status":"EXPORTED", "version":"0.5.65", "compositionId":composition_id,
        "features":features, "installable":false,
        "originalSha256":OFFICIAL_SHA, "combinedSha256":patched_sha,
        "changedFiles":changes.keys().collect::<Vec<_>>()
    });
    fs::write(output.join("receipt.json"), serde_json::to_vec_pretty(&receipt)?)?;
    Ok(receipt)
}

fn receipt_set(receipt: &Value) -> Result<PatchSet> {
    if receipt["status"] != "EXPORTED" || receipt["version"] != "0.5.65"
        || receipt["originalSha256"] != OFFICIAL_SHA
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
    if transaction::sha(&directory.join("original.asar"))? != OFFICIAL_SHA
        || transaction::sha(&directory.join("combined.asar"))? != digest
    {
        return Err(fail("통합 ASAR 또는 원본 복사본의 지문이 기록과 다릅니다."));
    }
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
    fn selected_adult_and_buffer_transforms_compose_without_claiming_installability() {
        let mut html = "</head>\n        <button class=\"nav\" data-view=\"search\"\n      <section id=\"historyView\"".to_owned();
        let mut app = "function toggleLibrary(\n  if(name==='player'&&current&&current!=='player')\n  if (name === 'history') renderHistory();\n    $('#detailContent').innerHTML=`<div class=\"detail-hero\"<p class=\"detail-synopsis\"\n    if(art?.banner)applyDetailArtwork(\nfunction play(src,\n    hlsPlayer.on(Hls.Events.MANIFEST_PARSED,\n$('#speed').onchange=".to_owned();
        let mut changes = BTreeMap::new();

        add_adult_catalog(&mut html, &mut app).unwrap();
        add_adult_catalog_stylesheet(&mut html, &mut changes).unwrap();
        add_fast_buffer(&mut app).unwrap();

        assert!(html.contains("data-view=\"adultCatalog\""));
        assert!(html.contains("adult-catalog.css"));
        assert!(app.contains("adultCatalog"));
        assert!(app.contains("bindAdultClassificationControls"));
        assert!(app.contains("updateFastHlsBuffer"));
        assert!(app.contains("Hls.Events.LEVEL_LOADED"));
        assert!(app.contains("playbackRate"));

        assert!(add_adult_catalog(&mut html, &mut app).is_err());
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
            let changes = add_selected_features(set, base).unwrap();
            let html = String::from_utf8(changes["src/index.html"].clone()).unwrap();
            let app = String::from_utf8(changes["src/app.js"].clone()).unwrap();
            let adult = set.contains(PatchId::AdultOnlyTab);
            let fast = set.contains(PatchId::DoubleSpeedBuffering);

            assert_eq!(html.contains("adult-catalog.css"), adult, "{}", set.id());
            assert_eq!(app.contains("adultCatalog"), adult, "{}", set.id());
            assert_eq!(app.contains("updateFastHlsBuffer"), fast, "{}", set.id());
            assert_eq!(changes.contains_key("src/adult-catalog.css"), adult, "{}", set.id());
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
