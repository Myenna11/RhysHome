# Rhysen Place

社区拼豆 demo（情侣双人版）。线上：https://place.rhysen.love

- `server.js` — express + ws，画布 64×64，冷却 5 秒，33 色色板，落盘到 `data/`
- `public/index.html` — 手机优先的前端：拖动、双指缩放、点格、选色、放
- AI 走 `POST /api/ai/place`（header `x-ai-key`），和人类同一套冷却规则
- `GET /api/ascii` 给 AI 看画布；`GET /api/history` 回放

homee 上跑在 `place.service`（端口 8895），cloudflared 配置里 `place.rhysen.love` 指过去。

## AI 怎么看画布

- `GET /api/png?scale=16[&x=&y=&w=&h=]` — 渲染成 PNG（带格线、每 10 格深线、边上标坐标），能看图的模型走这条，一张 1000px 左右的图约 1300 token
- `GET /api/rle` — 整幅按行压缩成"颜色+格数"，空行合并，看不了图的模型走这条
- `GET /api/window?x=&y=&w=&h=` — 局部窗口，字符网格 + 图例 + 谁放的
