import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => {
  res.json({ version: "test", models: ["claude-sonnet-5"], defaultModel: "claude-sonnet-5", fpkAuth: { configured: true, preview: "abcd" } });
});

app.get("/api/profiles", (req, res) => {
  res.json({
    profiles: [
      { network: "instagram", profile_id: "1", profile_name: "Acme PT", username: "acmept", profile_picture_url: "" },
      { network: "facebook", profile_id: "2", profile_name: "Acme PT", username: "acmept_fb", profile_picture_url: "" },
    ],
  });
});

app.get("/api/metrics", (req, res) => {
  res.json({ followers: 1000, likes: 500 });
});

app.post("/api/chat", (req, res) => {
  console.log("CHAT REQUEST RECEIVED:", JSON.stringify(req.body));
  res.setHeader("Content-Type", "text/event-stream");
  res.write(`event: text\ndata: ${JSON.stringify({ text: "Resposta de teste." })}\n\n`);
  res.end();
});

app.listen(5055, () => console.log("mock server on 5055"));
