import express from "express";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/setup", (_req, res) => {
  res.status(501).json({ error: "Not implemented" });
});

app.post("/tool/*", (_req, res) => {
  res.status(501).json({ error: "Not implemented" });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Container server listening on port ${PORT}`);
});
