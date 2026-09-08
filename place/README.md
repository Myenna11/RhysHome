# Rhysen Place

社区拼豆 demo（情侣双人版）。线上：https://place.rhysen.love

- `server.js` — express + ws，画布 64×64，冷却 5 秒，33 色色板，落盘到 `data/`
- `public/index.html` — 手机优先的前端：拖动、双指缩放、点格、选色、放
- AI 走 `POST /api/ai/place`（header `x-ai-key`），和人类同一套冷却规则
- `GET /api/ascii` 给 AI 看画布；`GET /api/history` 回放

homee 上跑在 `place.service`（端口 8895），cloudflared 配置里 `place.rhysen.love` 指过去。
