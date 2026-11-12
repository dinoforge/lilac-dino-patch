//! Native Rust desktop window, without Electron, JavaScript or Python runtime.
use crate::{transaction, Result};
use eframe::egui;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant, SystemTime};

struct ResultMessage {
    name: String,
    result: Result<transaction::Status>,
}

struct DinoUi {
    root: String,
    status: transaction::Status,
    auto_enabled: bool,
    busy: bool,
    activity: Vec<String>,
    response: Option<Receiver<ResultMessage>>,
    last_archive_change: Option<(u64, Option<SystemTime>)>,
    last_monitor: Instant,
    backup_id: String,
    show_log: bool,
    show_advanced: bool,
}

impl Default for DinoUi {
    fn default() -> Self {
        let root = std::env::var("DINO_ORIGINAL_ROOT").unwrap_or_default();
        Self {
            root,
            status: transaction::Status::new("NO_SOURCE", "", "설치된 공식 LilacAnime 폴더를 선택하세요."),
            auto_enabled: true,
            busy: false,
            activity: vec!["DinoPatch Rust 관리자가 시작됐습니다.".into()],
            response: None,
            last_archive_change: None,
            last_monitor: Instant::now(),
            backup_id: String::new(),
            show_log: false,
            show_advanced: true,
        }
    }
}

impl DinoUi {
    fn record(&mut self, text: impl Into<String>) {
        let time = chrono::Local::now().format("%H:%M:%S");
        self.activity.push(format!("[{time}] {}", text.into()));
        if self.activity.len() > 250 { self.activity.drain(..self.activity.len()-250); }
    }

    fn enqueue(&mut self, kind: &'static str) {
        if self.busy || self.root.is_empty() { return; }
        self.busy = true;
        self.record(format!("{} 검사 시작", kind));
        let root = PathBuf::from(self.root.clone());
        let backup = self.backup_id.clone();
        let (sender, receiver) = mpsc::channel();
        self.response = Some(receiver);
        std::thread::spawn(move || {
            let result = match kind {
                "원본 검사" => Ok(transaction::inspect(&root)),
                "자동 검사" => transaction::apply(&root, false),
                "수동 적용" => transaction::apply(&root, true),
                "패치 해제" => transaction::uninstall(&root),
                "복구 검증" => transaction::review_recovery(&root),
                "복구 기록 정리" => transaction::recover(&root),
                "백업 복원" => transaction::restore(&root, &backup),
                _ => Err(crate::fail("지원하지 않는 작업입니다.")),
            };
            let _ = sender.send(ResultMessage { name: kind.into(), result });
        });
    }

    fn poll_result(&mut self) {
        let message = self.response.as_ref().and_then(|rx| rx.try_recv().ok());
        if let Some(event) = message {
            self.busy = false;
            self.response = None;
            match event.result {
                Ok(status) => {
                    self.record(format!("{} · {} · {}", event.name, status.status, status.reason));
                    self.status = status;
                    if !self.root.is_empty() {
                        if let Ok(list) = transaction::backups(&PathBuf::from(&self.root)) {
                            if let Some(id) = list["items"].as_array().and_then(|v|v.first())
                                .and_then(|x|x["id"].as_str()) {
                                self.backup_id = id.to_owned();
                            }
                        }
                    }
                }
                Err(error) => {
                    self.record(format!("{} 실패: {}", event.name,error));
                    self.status = transaction::Status::new("PARTIAL_OR_UNKNOWN",&self.status.version,error.to_string());
                }
            }
        }
    }

    fn monitor(&mut self) {
        if !self.auto_enabled || self.busy || self.root.is_empty() {return;}
        if self.last_monitor.elapsed() < Duration::from_secs(4) {return;}
        self.last_monitor=Instant::now();
        let path=PathBuf::from(&self.root).join("resources").join("app.asar");
        let current=std::fs::metadata(&path).ok().filter(|meta|meta.is_file())
            .map(|meta|(meta.len(),meta.modified().ok()));
        if current.is_none() {
            // Repeated invalid archive or updater transitions are not automatically
            // retried forever. Manual inspection remains independently available.
            if self.last_archive_change.is_some() {
                self.last_archive_change=None;
                self.status=transaction::Status::new("PARTIAL_OR_UNKNOWN",&self.status.version,
                    "app.asar 파일이 없거나 폴더입니다. 복구 기록과 원본은 보존합니다.");
                self.record("원본 파일 구조가 불안정해 자동 적용을 보류했습니다.");
            }
            return;
        }
        let changed=self.last_archive_change.as_ref()!=current.as_ref();
        self.last_archive_change=current;
        if changed {self.enqueue("자동 검사");}
    }

    fn choose_folder(&mut self) {
        if self.busy{return;}
        if let Some(path)=rfd::FileDialog::new().set_title("원본 LilacAnime 설치 폴더").pick_folder(){
            self.root=path.to_string_lossy().to_string();
            self.last_archive_change=None;
            self.status=transaction::Status::new("SOURCE_FOUND","","사용자가 설치본 경로를 선택했습니다.");
            self.record(format!("설치본 경로 선택: {}",self.root));
            self.enqueue("원본 검사");
        }
    }
}

impl eframe::App for DinoUi {
    fn update(&mut self, ctx:&egui::Context, _frame:&mut eframe::Frame) {
        self.poll_result();
        self.monitor();
        ctx.request_repaint_after(Duration::from_millis(200));
        egui::CentralPanel::default().show(ctx,|ui|{
            ui.heading("LilacAnime DinoPatch");
            ui.label("Rust 관리자 · 설치된 공식 원본만 수정 · 백업 자동 보존");
            ui.add_space(12.0);
            ui.group(|ui|{
                ui.label(egui::RichText::new("공식 원본 설치 폴더").strong());
                ui.horizontal(|ui|{
                    ui.add_sized([ui.available_width()-115.0,26.0],egui::TextEdit::singleline(&mut self.root).hint_text("D:\\LilacAnime"));
                    if ui.add_enabled(!self.busy,egui::Button::new("폴더 선택")).clicked(){self.choose_folder();}
                });
                ui.label(format!("공식 원본: {}",if self.status.version.is_empty(){"확인 전".into()}else{format!("v{}",self.status.version)}));
                ui.label(format!("패치 상태: {}",self.status.status));
                ui.label(&self.status.reason);
                if self.status.manually_uninstalled {ui.label("수동 해제 유지: 자동 재적용하지 않습니다.");}
            });
            ui.add_space(8.0);
            ui.horizontal(|ui|{
                ui.checkbox(&mut self.auto_enabled,"원본 변경 자동 확인");
                if ui.add_enabled(!self.busy && !self.root.is_empty(),egui::Button::new("원본 다시 확인")).clicked(){self.enqueue("원본 검사");}
            });
            ui.add_space(8.0);
            ui.horizontal_wrapped(|ui|{
                if ui.add_enabled(!self.busy && !self.root.is_empty() && self.status.status!="APPLIED",
                    egui::Button::new("디노 패치 수동 적용")).clicked() {self.enqueue("수동 적용");}
                if ui.add_enabled(!self.busy && self.status.status=="APPLIED",
                    egui::Button::new("패치 해제")).clicked(){self.enqueue("패치 해제");}
                if ui.add_enabled(!self.busy && !self.root.is_empty(),
                    egui::Button::new("복구 상태 검사")).clicked(){self.enqueue("복구 검증");}
            });
            ui.add_space(6.0);
            ui.collapsing("고급 도구 · 원본 백업 및 진단",|ui|{
                ui.horizontal_wrapped(|ui|{
                    ui.label(format!("백업 ID: {}",if self.backup_id.is_empty(){"없음"}else{&self.backup_id}));
                    if ui.add_enabled(!self.busy && !self.backup_id.is_empty() && self.status.status=="APPLIED",
                        egui::Button::new("백업 원복")).clicked(){self.enqueue("백업 복원");}
                });
                if self.status.recovery_available {
                    ui.label("원본과 복구 기록의 SHA-256이 일치합니다.");
                    if ui.add_enabled(!self.busy,egui::Button::new("검증된 복구 기록 정리")).clicked(){
                        self.enqueue("복구 기록 정리");
                    }
                }
                ui.label("공식 릴리즈 확인: github.com/whispelyn-byte/LilacAnime-desktop/releases");
                self.show_log=true;
            });
            ui.add_space(10.0);
            ui.separator();
            ui.horizontal(|ui|{
                ui.label(if self.busy {"상태: 작업 실행 중"}else{"상태: 대기"});
                ui.checkbox(&mut self.show_log,"상세 로그 표시");
            });
            if self.show_log {
                egui::ScrollArea::vertical().stick_to_bottom(true).max_height(245.0).show(ui,|ui|{
                    for line in &self.activity {ui.label(line);}
                });
            }
            ui.add_space(12.0);
            ui.label("원본 프로그램은 배포하지 않습니다. app.asar 폴더·손상·미확인 상태에서는 강제 적용하지 않습니다.");
        });
    }
}

fn register_windows_korean_font(ctx:&egui::Context) {
    #[cfg(windows)]
    {
        let windows=std::env::var("WINDIR").unwrap_or_else(|_|r"C:\Windows".into());
        let font=PathBuf::from(windows).join("Fonts").join("malgun.ttf");
        if let Ok(bytes)=std::fs::read(font){
            let mut fonts=egui::FontDefinitions::default();
            fonts.font_data.insert("system-hangul".into(),egui::FontData::from_owned(bytes).into());
            for family in [egui::FontFamily::Proportional,egui::FontFamily::Monospace] {
                fonts.families.entry(family).or_default().insert(0,"system-hangul".into());
            }
            ctx.set_fonts(fonts);
        }
    }
    #[cfg(not(windows))]
    { let _ = ctx; }
}

pub fn start() -> Result<()> {
    let options=eframe::NativeOptions{
        viewport:egui::ViewportBuilder::default().with_inner_size([820.0,640.0])
            .with_min_inner_size([650.0,500.0]),
        ..Default::default()
    };
    eframe::run_native(
        "LilacAnime DinoPatch · Rust",
        options,
        Box::new(|cc|{
            register_windows_korean_font(&cc.egui_ctx);
            Ok(Box::<DinoUi>::default())
        })
    ).map_err(|err| crate::fail(format!("Rust GUI 실행 실패: {err}")))
}
