import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { readStateJson, writeStateText } from "./state-file";

/**
 * This plugin instance's identity (0.6.0): an id and a secret, made once and
 * kept in its state folder. Backup folders it makes are signed with the
 * secret, so pruning only ever touches folders this instance provably made.
 * If the state folder is lost, older folders simply stop verifying, and are
 * kept (never pruned).
 */

const FILE = "instance";
const InstanceSchema = z.object({ version: z.literal(1), id: z.string().min(8), secret: z.string().min(32) });
export type Instance = z.infer<typeof InstanceSchema>;

let instance: Promise<Instance | null> | null = null;

async function load(): Promise<Instance | null> {
  const parsed = InstanceSchema.safeParse(await readStateJson(FILE));
  if (parsed.success) return parsed.data;
  const made: Instance = { version: 1, id: randomBytes(8).toString("hex"), secret: randomBytes(32).toString("hex") };
  // Without a saved secret nothing can be verified later, so a failed save means no signing (and so no pruning).
  return (await writeStateText(FILE, JSON.stringify(made))) ? made : null;
}

/** The instance, or null when its secret couldn't be kept (then nothing is signed, and nothing pruned). */
export function currentInstance(): Promise<Instance | null> {
  instance ??= load();
  return instance;
}

/** For tests: forget what is in memory (the file stays). */
export function forgetInstance(): void {
  instance = null;
}

export function sign(secret: string, text: string): string {
  return createHmac("sha256", secret).update(text).digest("hex");
}

export function signatureMatches(secret: string, text: string, signature: string): boolean {
  const expected = Buffer.from(sign(secret, text), "hex");
  const given = Buffer.from(signature, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
