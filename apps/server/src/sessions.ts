import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnimationResult, ImageAsset, IsolationResult, MaskCandidate, SubjectDescription } from "@h3-motion/shared";
import { DATA_ROOT } from "./config.js";
import type { ManagedJob } from "./jobs/runtime.js";

export interface StoredImage extends ImageAsset { path: string }
export interface StoredCandidate extends MaskCandidate { path: string; imageId: string }
export interface Session {
  id: string;
  files: Map<string, string>;
  candidates: Map<string, StoredCandidate>;
  image?: StoredImage;
  selection?: StoredImage;
  description?: SubjectDescription & { imageId: string; maskId: string; userText: string };
  isolation?: IsolationResult;
  animation?: AnimationResult;
  job?: ManagedJob;
}

export class SessionStore {
  readonly sessions = new Map<string, Session>();
  constructor(readonly root = DATA_ROOT) {}

  create(): Session {
    const session: Session = { id: randomUUID(), files: new Map(), candidates: new Map() };
    this.sessions.set(session.id, session);
    return session;
  }

  savePng(session: Session, bytes: Uint8Array): Promise<{ id: string; url: string; path: string }> {
    return this.saveFile(session, bytes, "png");
  }

  async saveFile(session: Session, bytes: Uint8Array, extension: "png" | "mp4" | "webm"): Promise<{ id: string; url: string; path: string }> {
    const id = randomUUID();
    const directory = join(this.root, session.id);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${id}.${extension}`);
    await writeFile(path, bytes);
    session.files.set(id, path);
    return { id, url: `/api/files/${id}`, path };
  }
}

export function isBusy(session: Session): boolean {
  return session.job?.snapshot.status === "queued" || session.job?.snapshot.status === "running";
}

export function clearIsolation(session: Session): void {
  session.description = undefined;
  session.isolation = undefined;
  session.animation = undefined;
}
