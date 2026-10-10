# ChatGPT 자막 번역 연결 상태

확인일: 2026-10-10

## 지금 지원하는 흐름

플레이어의 ChatGPT 수동 번역은 선택된 자막 cue를 언어별 사용자 프롬프트와 함께 클립보드에 복사하고 `chatgpt.com`을 연다. 사용자가 직접 붙여넣고 전송한 뒤, 앱은 cue ID를 확인해 결과를 WebVTT에 반영한다. 원래 cue 시간·헤더·순서는 앱이 보존한다. 앱은 ChatGPT 로그인 정보, 쿠키, 세션 토큰을 읽지 않으며 요청을 자동 전송하지 않는다. 자동 번역은 기존 로컬 AI 및 설정된 번역 API의 경로를 유지한다.

## 공식 ChatGPT 요금제 연결 가능성

OpenAI는 “Sign in with ChatGPT”와 ChatGPT 요금제 사용량 공유 기능을 문서화했다. 이 방식은 API 키를 앱에 입력하는 방식과 구별되며, 공개 오픈소스 클라이언트와 선택된 비공개 파트너를 대상으로 한다. 비공개 앱은 파트너 승인/제한된 시험 자격이 필요하다. 요청 후에는 사용자가 권한과 사용량을 승인해야 하며, 이 토큰은 공개 Responses API에서만 쓰고 ChatGPT 내부 웹 API에 사용하지 않는다.

이 저장소 `dinoforge/anime-player`는 비공개이며 승인된 파트너라는 근거가 없다. 따라서 작동한다고 가장하는 OAuth나 토큰 연결은 구현하지 않는다. 저장소 공개 전환·파트너 신청도 하지 않는다. 자격이 확인되면 별도의 공식 연결 어댑터를 검토할 수 있다. 사용자가 ChatGPT에 붙여넣기 전까지 외부 전송은 일어나지 않으며, 붙여넣고 보내면 사용자가 선택한 자막 내용이 ChatGPT로 전송된다.

공식 자료:

- [Sign in with ChatGPT Quickstart](https://developers.openai.com/siwc/quickstart)
- [Open-source token sharing overview](https://developers.openai.com/siwc/token-sharing-open-source)
- [Open-source token sharing sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Use your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)
