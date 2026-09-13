import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL || "admin@eggmart.test";
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    console.log(`No user row found for ${email} — seed never actually created it.`);
    return;
  }

  console.log({ id: user.id, email: user.email, role: user.role, status: user.status, shopId: user.shopId });

  const candidates = ["Admin@12345", process.env.SEED_ADMIN_PASSWORD].filter(Boolean) as string[];
  for (const pw of candidates) {
    console.log(`"${pw}" matches stored hash:`, await bcrypt.compare(pw, user.passwordHash));
  }
}

main().finally(() => prisma.$disconnect());