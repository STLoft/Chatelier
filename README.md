# Chatelier

SillyTavern용 이미지 생성 확장입니다. 대화에서 가져온 장면과 직접 작성한 프롬프트로 이미지를 만들고, 결과를 채팅에 삽입할 수 있습니다.

편집 가능한 기본 프롬프트 하나를 제공합니다. 프롬프트를 직접 수정하거나 원하는 이름으로 프리셋을 추가할 수 있습니다.

## 설치에 필요한 두 구성품

| 구성품 | 역할 | 설치 위치 |
| --- | --- | --- |
| [Chatelier](https://github.com/STLoft/Chatelier) | 화면, 프롬프트, 프리셋, 생성 기록 | SillyTavern의 확장 설치 메뉴 |
| [Chatelier-Bridge](https://github.com/STLoft/Chatelier-Bridge) | Codex CLI 실행, 생성 이미지 보관 | SillyTavern 서버의 `plugins` 폴더 |

**PC와 터먹스 모두 같은 두 저장소를 사용합니다.** 확장 주소를 한 번 입력하는 것만으로 서버 플러그인까지 설치되지는 않습니다.

휴대폰 브라우저로 PC의 SillyTavern에 접속한다면 서버 플러그인과 Codex CLI는 **PC에** 설치합니다. 휴대폰 터먹스에서 SillyTavern 서버를 실행한다면 **그 터먹스에** 설치합니다.

## 주요 기능

- 최근 AI 응답 또는 메시지 번호 구간에서 장면 가져오기
- 장면샷 / 1인샷
- 직접 작성하는 이미지 프롬프트와 사용자 프리셋
- 프리셋 추가, 저장, 복제, 이름 변경, 삭제
- JSON 프리셋 가져오기 / 전체 내보내기
- 캐릭터·페르소나·화풍 참조 이미지
- Codex CLI 또는 Vertex AI 생성
- 선택적으로 SillyTavern Connection Profile을 사용한 장면 정리
- 생성 기록, 이미지 다운로드, 채팅 삽입

## 빠른 설치

### 1. 서버 플러그인과 Codex CLI 준비

먼저 [Chatelier-Bridge 설치 안내](https://github.com/STLoft/Chatelier-Bridge#설치)를 따라 서버 플러그인과 Codex CLI를 준비합니다.

터먹스 사용자는 [터먹스 전용 안내](https://github.com/STLoft/Chatelier-Bridge/blob/main/docs/TERMUX.md)를 이용하세요. 현재 네이티브 터먹스에서 진행하는 방법입니다.

### 2. 확장 설치

1. SillyTavern을 열고 상단의 **확장** 메뉴로 이동합니다.
2. **확장 설치 / Install extension**를 누릅니다.
3. 아래 주소를 붙여 넣고 설치합니다.

```text
https://github.com/STLoft/Chatelier
```

4. 브라우저를 새로고침합니다.
5. 확장 설정 목록의 **Chatelier**를 열거나, 마법봉 메뉴의 **Chatelier**를 선택합니다.

설치 대상이 표시되는 환경에서는 현재 사용자 또는 모든 사용자 중 필요한 대상을 선택하세요. 서버 플러그인은 별도로 설치해야 합니다.

### 3. 첫 생성

1. Chatelier의 **설정** 탭에서 이미지 엔진을 **Codex CLI**로 선택합니다.
2. 상태에 CLI 버전과 ChatGPT 로그인 상태가 표시되는지 확인합니다.
3. PC의 `app-server` 방식에서는 모델 목록을 새로고침하고 사용할 모델을 선택합니다.
4. 터먹스의 `exec` 방식에서는 모델 ID를 비워 두면 Codex CLI의 기본 모델을 사용합니다. 특정 모델을 원할 때만 ID를 입력합니다.
5. 필요한 참조 이미지와 장면 정리 방식을 선택한 뒤 **설정 저장**을 누릅니다.
6. **만들기** 탭에서 프롬프트를 작성하고 **저장**을 누릅니다.
7. 장면으로 사용할 AI 응답이 있는 대화방에서 **이미지 생성**을 누릅니다.

모델 목록에 표시된다는 사실만으로 해당 계정의 이미지 생성 권한까지 확인되는 것은 아닙니다. 실제 요청이 성공하는지 확인해야 합니다.

## 프롬프트와 프리셋

만들기 탭에서는 프리셋 선택만 바로 표시하고, 본문과 관리 버튼은 **프롬프트 편집**을 펼쳤을 때 표시합니다. 설정 탭에서는 전체 편집 화면을 볼 수 있습니다.

처음 설치하면 `기본` 프리셋 하나가 있으며 내용은 아래와 같습니다. 화풍별 분류는 없습니다.

```text
masterpiece, best quality,
[background: {bg}],
[characters: {char}],
[outfit: {outfit}],
[composition: {comp}],
[style: korean manhwa style, clean cel shading, muted soft colors, slice of life],
natural soft lighting, film grain, no text, no watermark, subtle details, cinematic mood
```

기본 프롬프트는 한국 웹툰 화풍의 예시이며 자유롭게 수정할 수 있습니다. **새 프리셋**은 `{scene}` 하나에서 시작합니다. `{scene}`은 선택한 대화의 장면으로 치환됩니다. 원하는 화풍, 색감, 구도 등의 지시문을 앞뒤에 작성하세요.

```text
원하는 화풍과 색감에 대한 지시문

{scene}

구도와 표현에 대한 추가 지시문
```

화풍 문구만 작성하고 자리표시자를 넣지 않으면 장면을 뒤에 붙입니다. 프롬프트 편집은 자동 저장되며 **저장** 버튼으로도 저장할 수 있습니다. 서버 연결 설정을 변경했다면 **설정 저장**을 누르세요.

| 버튼 | 동작 |
| --- | --- |
| 새 프리셋 | 이름을 입력하고 `{scene}`에서 시작 |
| 복제 | 현재 내용으로 새 프리셋 생성 |
| 이름 변경 | 현재 프리셋의 이름 변경 |
| 삭제 | 현재 프리셋 삭제. 마지막 하나는 유지 |
| 전체 내보내기 | 모든 프리셋을 `chatelier-presets.json`으로 저장 |
| 가져오기 | 기존 목록을 유지하고 파일의 프리셋을 추가 |

같은 이름의 프리셋을 가져오면 번호를 붙여 구분합니다. 가져오기는 파일당 1MB, 한 번에 1~100개, 이름 80자, 프롬프트 30,000자까지 지원합니다.

### 프리셋 공유 파일에 포함되는 정보

내보내기는 **프리셋 이름과 프롬프트 본문만** 포함합니다. API 키, 로그인 정보, 연결 프로필, 참조 사진, 생성 이미지와 기록은 포함하지 않습니다. 다만 사용자가 프롬프트 본문에 직접 적은 내용은 그대로 포함되므로 공유 전에 확인하세요.

### 고급 자리표시자

장면 정리를 **SillyTavern API 프로필로 선처리**로 설정한 경우 아래 변수를 사용할 수 있습니다.

| 변수 | 내용 |
| --- | --- |
| `{scene}` | 정리된 장면 전체 |
| `{bg}` | 배경과 장소 |
| `{char}` | 인물 정보 |
| `{outfit}` | 의상 |
| `{comp}` | 구도, 포즈, 표정 |

Codex CLI 내부 처리를 사용한다면 `{scene}`을 권장합니다. 내부 처리에서는 `{bg}`에도 원본 장면이 들어가며 나머지 세 변수는 비워집니다.

## 장면과 참조 이미지

**장면 소스**를 펼치면 최근 AI 응답 또는 메시지 번호 구간을 선택할 수 있습니다. 메시지 구간은 0부터 시작하며 시작과 끝을 모두 포함합니다. 메시지에 추가되는 이미지 버튼으로도 해당 메시지나 구간을 선택할 수 있습니다.

**설정 → 참조 이미지**에서 다음 중 하나를 선택합니다.

- 대화방 프사 자동 사용: 현재 대화의 캐릭터·페르소나 이미지를 참고합니다.
- 이미지 직접 첨부: 직접 선택한 이미지를 참고합니다. 캐릭터 업로드는 캐릭터·그룹별, 페르소나와 화풍 업로드는 공통으로 저장됩니다.
- 사용 안 함: 캐릭터·페르소나 참조를 끕니다. 별도로 등록한 화풍 이미지는 사용할 수 있습니다.

캐릭터·페르소나는 정체성, 화풍 이미지는 표현 방식의 참고 자료로 전달합니다. 결과가 참고 자료와 정확히 일치하는지는 생성 모델에 따라 달라집니다.

## 생성 결과와 기록

생성 결과에서 **대화에 삽입**, **PNG 저장**, **다시 생성**을 사용할 수 있습니다. 이미지 크기는 설정의 **대화 삽입 이미지 폭 (%)**로 조절합니다. 이미지가 삽입될 메시지에 `<Info_panel>` 태그가 있으면 그 앞에 넣고, 없으면 메시지 끝에 추가합니다.

최근 생성 기록은 최대 20개입니다. 기록 항목과 서버의 이미지 파일은 별개입니다. 서버 파일을 지우면 해당 파일을 가리키는 기록에서 이미지를 다시 열 수 없습니다. 이미 채팅으로 저장·삽입한 사본은 별도 저장 경로를 사용합니다.

## Vertex AI 사용

설정의 엔진을 **Vertex AI**로 변경하고 본인의 **Express API Key**를 입력합니다. Vertex AI를 사용해도 생성 이미지 보관과 기록 기능을 위해 **Chatelier-Bridge가 필요합니다.** Codex CLI 설치·로그인은 Codex CLI 엔진을 사용할 때 필요합니다.

API 키는 사용자별 SillyTavern 확장 설정에 저장됩니다. 프리셋 공유 파일에는 포함되지 않습니다.

## 업데이트

1. SillyTavern의 확장 관리에서 Chatelier를 업데이트합니다.
2. 서버 플러그인은 SillyTavern 서버 폴더의 터미널에서 업데이트합니다.

```sh
git -C plugins/Chatelier-Bridge pull --ff-only
```

3. SillyTavern **서버를 종료 후 다시 시작**합니다.
4. 브라우저를 새로고침합니다.

서버의 `enableServerPluginsAutoUpdate` 설정이 켜져 있으면 Git으로 설치한 서버 플러그인의 업데이트를 시작 시 확인합니다. 확장과 서버 플러그인은 별도로 업데이트되므로 함께 확인하세요. Codex CLI 업데이트는 [서버 플러그인 안내](https://github.com/STLoft/Chatelier-Bridge#업데이트)를 따릅니다.

## 문제 해결

| 증상 | 확인할 항목 |
| --- | --- |
| Chatelier 메뉴가 없음 | 확장 설치 여부, 브라우저 새로고침, 확장 활성화 상태 |
| Chatelier-Bridge 설치 안내 / 404 | 서버 플러그인 설치 위치, `enableServerPlugins: true`, 서버 재시작 |
| Codex CLI 없음 | 서버가 실행되는 환경의 `codex --version`, `ST_CODEX_BIN` 설정 |
| 로그인 필요 | 같은 서버 환경에서 `codex login`과 `codex login status` 실행 |
| PC에서 모델 선택 오류 | 모델 목록 새로고침 후 모델 선택 및 설정 저장 |
| 터먹스 모델 목록이 없음 | exec 방식에서는 정상. 모델 ID를 비워 두거나 직접 입력 |
| 장면을 찾을 수 없음 | AI 응답이 있는 대화방인지, 메시지 구간이 유효한지 확인 |
| 도구가 없거나 텍스트만 반환됨 | CLI 버전, 선택 모델, 계정의 이미지 생성 제공 여부 확인 |
| 기록 이미지가 열리지 않음 | 서버 이미지 파일 삭제·이동 여부 확인 |

서버 설치, 터먹스 로그인, 경로와 실행 오류는 [Chatelier-Bridge 문제 해결](https://github.com/STLoft/Chatelier-Bridge#문제-해결)과 [터먹스 안내](https://github.com/STLoft/Chatelier-Bridge/blob/main/docs/TERMUX.md)를 참고하세요.

## 제거

SillyTavern의 확장 관리에서 Chatelier를 제거합니다. 서버 플러그인까지 제거하려면 먼저 SillyTavern 서버를 종료하고 `plugins/Chatelier-Bridge` 폴더를 다른 곳에 백업한 뒤 제거합니다. 서버 플러그인 폴더에는 생성 이미지가 있으므로 필요한 파일을 먼저 보관하세요. 이 작업으로 Codex CLI 자체나 로그인 정보가 삭제되지는 않습니다.

## 참고 문서

- [SillyTavern 확장](https://docs.sillytavern.app/extensions/)
- [SillyTavern 서버 플러그인](https://docs.sillytavern.app/for-contributors/server-plugins/)
- [OpenAI Docs: Codex CLI](https://learn.chatgpt.com/docs/codex/cli)

이 확장은 STLoft의 커뮤니티 프로젝트이며, SillyTavern 또는 OpenAI의 공식 확장이 아닙니다.
