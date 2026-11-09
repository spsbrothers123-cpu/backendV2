import dotenv from "dotenv";

const envFile = process.env.NODE_ENV === "test" ? ".env.test" : ".env";
dotenv.config({ path: envFile });
// optional fallback so shared vars in .env still apply
dotenv.config({ path: ".env" });