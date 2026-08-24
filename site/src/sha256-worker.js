self.onmessage = async ({ data }) => {
  try {
    const file = data?.file;
    if (!(file instanceof Blob) || file.size < 1) throw new Error("The selected video is empty.");
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    self.postMessage({ ok: true, sha256 });
  } catch (error) {
    self.postMessage({ ok: false, message: error instanceof Error ? error.message : "The video could not be hashed." });
  }
};
