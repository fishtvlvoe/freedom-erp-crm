---
change: line-personal-ai-inbox
updated: 2026-10-20
---

# dev-flow 進度

## ① Grilling 對齊

- [x] 已完成 30 題需求、安全邊界與第一里程碑範圍確認。
- 證據：`docs/sr-drafts/line-personal-ai-inbox-notes.md`。

## ② 詞彙表與 Gherkin 測試劇本

- [x] 已建立並獲 Fish 確認 `CONTEXT.md`。
- [x] 已建立並獲 Fish 確認 `e2e/features/line-personal-ai-inbox-frontend.feature`。
- [x] 已建立並獲 Fish 確認 `e2e/features/line-personal-ai-inbox-backend.feature`。

## ③ Spectra SR

- [x] `[PM]` 建立四份英文 capability specs、`tasks.md` 與本進度表。
- [x] `[PM]` 執行 `spectra analyze line-personal-ai-inbox --json` 與 `spectra validate line-personal-ai-inbox`；Coverage／Consistency／Gaps 為 0，validate 為 valid。
- [x] Fish 以本次實作指示授權依既有 proposal、design、specs 與 tasks 進入本地實作。

## ④ 實作

- [x] 在本工作樹完成 fake LINE domain／Worker API、Fish／家人登入與 RBAC、遮罩／稽核／備份邊界及 Dashboard；沒有接入真實 provider。

## ⑤ 本功能測試

- [x] focused unit/API 7/7 與 Playwright 5/5 通過；測試檔與前後端 Gherkin 已納入 change。

## ⑥ 舊功能回歸

- [x] 本地全套 tests 191（190 pass、1 skip、0 fail）、Worker dry-run 與本地 build 通過。
- [ ] 外部 `verify-public-build` 未驗證：目前公開站仍回傳不同 build，且本次未部署；不列為完成。

## ⑦ PM 四關走查

- [ ] 尚未動工；必須用 ego-browser 以三種測試身分走查桌面與手機寬度。

## ⑧ Fish 驗收

- [ ] 尚未開始；只能在 PM 完成四關自驗且沒有背景測試佔用環境後進行。

## ⑨ PR 與 retro

- [ ] 尚未動工；需先完成 Fish 驗收，再走 PR 與白話版 retro HTML。

## ⑩ Archive

- [ ] 尚未動工；需在 tasks 全部完成、validation 0 warnings、retro 完成後執行 `spectra archive`。

## 明確未動工

- 真實 `linejs` 個人帳號登入與同步。
- 真實 AI Provider、Google Drive OAuth／加密上傳與 Email delivery provider。
- 真實 OpenChat 讀取、歷史補抓與送出能力。
