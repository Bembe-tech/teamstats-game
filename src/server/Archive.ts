import z from "zod";
import {
  GameID,
  GameRecord,
  GameRecordSchema,
  ID,
  PartialGameRecord,
} from "../core/Schemas";
import { replacer } from "../core/Util";
import { registeredSite } from "./ClusterCheckin";
import { logger } from "./Logger";
import { ServerEnv } from "./ServerEnv";
import { sendToSite } from "./SiteLink";

const log = logger.child({ component: "Archive" });

export async function archive(gameRecord: GameRecord) {
  if (!ServerEnv.openFrontApi()) {
    // StreamLobby: no OpenFront archive. TeamStats.Pro keeps a short summary on the players' site
    // profiles, and the whole record (turns too) on the game's own disk for "Last games" and replays
    // (teamstats/front.cjs /internal/game-record, Bembe 2026-11-18).
    await Promise.all([sendToSite(gameRecord), sendRecordToFront(gameRecord)]);
    return;
  }
  try {
    const parsed = GameRecordSchema.safeParse(gameRecord);
    if (!parsed.success) {
      log.error(`invalid game record: ${z.prettifyError(parsed.error)}`, {
        gameID: gameRecord.info.gameID,
      });
      return;
    }
    const url = `${ServerEnv.jwtIssuer()}/game/${gameRecord.info.gameID}`;
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify(gameRecord, replacer),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ServerEnv.apiKey(),
      },
    });
    if (!response.ok) {
      log.error(`error archiving game record: ${response.statusText}`, {
        gameID: gameRecord.info.gameID,
      });
      return;
    }
  } catch (error) {
    log.error(`error archiving game record: ${error}`, {
      gameID: gameRecord.info.gameID,
    });
    return;
  }
}

// The whole finished game to the front proxy, which stores it (loopback + API_KEY only).
async function sendRecordToFront(record: GameRecord) {
  const port = Number(process.env.TSP_FRONT_PORT ?? 0);
  const key = process.env.API_KEY ?? "";
  if (!port || !key) return;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/internal/game-record`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tsp-internal": key },
      body: JSON.stringify(record, replacer),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) log.warn(`front refused the game record: ${r.status}`);
  } catch (e) {
    log.warn(`cannot hand the game record to the front: ${e}`, {
      gameID: record.info.gameID,
    });
  }
}

export async function readGameRecord(
  gameId: GameID,
): Promise<GameRecord | null> {
  if (!ServerEnv.openFrontApi()) return null; // StreamLobby: no game archive
  try {
    if (!ID.safeParse(gameId).success) {
      log.error(`invalid game ID: ${gameId}`);
      return null;
    }
    const url = `${ServerEnv.jwtIssuer()}/game/${gameId}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ServerEnv.apiKey(),
      },
    });
    const record = await response.json();
    if (!response.ok) {
      log.error(`error reading game record: ${response.statusText}`, {
        gameID: gameId,
      });
      return null;
    }
    return GameRecordSchema.parse(record);
  } catch (error) {
    log.error(`error reading game record: ${error}`, {
      gameID: gameId,
    });
    return null;
  }
}

export function finalizeGameRecord(
  clientRecord: PartialGameRecord,
): GameRecord {
  return {
    ...clientRecord,
    gitCommit: ServerEnv.gitCommit(),
    subdomain: ServerEnv.subdomain(),
    domain: ServerEnv.domain(),
    site: registeredSite(),
  };
}
