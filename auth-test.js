import fs from "fs";
import { google } from "googleapis";

const SA = JSON.parse(fs.readFileSync("./service-account.json", "utf8"));

console.log("SA email:", SA.client_email);
console.log("SA project:", SA.project_id);
console.log("SA key id:", SA.private_key_id);
console.log("SA type:", SA.type);

const auth = new google.auth.JWT({
  email: SA.client_email,
  key: SA.private_key,
  scopes: ["[googleapis.com](https://www.googleapis.com/auth/spreadsheets)"],
});

try {
  const token = await auth.getAccessToken();
  console.log("TOKEN OK:", !!token?.token);
  console.log("TOKEN PREVIEW:", token?.token ? token.token.slice(0, 20) + "..." : "NO TOKEN");
} catch (err) {
  console.error("TOKEN FAIL FULL:", err);
  console.error("TOKEN FAIL RESPONSE:", err?.response?.data);
}
