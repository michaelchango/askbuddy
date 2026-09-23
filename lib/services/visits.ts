// 体验访问记录服务：记录「开始体验」事件并提供运营统计。
// 仅用于统计有多少人来体验、谁在活跃；不参与业务数据隔离。
import { db } from "@/lib/db";

export interface Visit {
  id?: number;
  nickname: string;
  user_agent?: string | null;
  referer?: string | null;
  ip?: string | null;
  created_at?: string;
}

/**
 * 确保 visits 表存在（幂等）。生产上 prebuild 建表可能因凭据（401）/网络问题被跳过，
 * 导致首次查询报 `relation "visits" does not exist` 直接 500。这里在首次读写前兜底建表。
 * mock / nosql 后端不支持 queryRaw，会抛错并被忽略（内存后端本就无需建表）。
 */
let visitsTableEnsured = false;
async function ensureVisitsTable(): Promise<void> {
  if (visitsTableEnsured) return;
  try {
    await db.queryRaw(
      "visits",
      `CREATE TABLE IF NOT EXISTS visits (
        id BIGINT GENERATED ALWAYS AS IDENTITY,
        nickname TEXT NOT NULL,
        user_agent TEXT NULL,
        referer TEXT NULL,
        ip TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT pk_visits PRIMARY KEY (id)
      )`
    );
    await db.queryRaw(
      "visits",
      `CREATE INDEX IF NOT EXISTS idx_visits_created ON visits (created_at DESC)`
    );
    await db.queryRaw(
      "visits",
      `CREATE INDEX IF NOT EXISTS idx_visits_nick ON visits (nickname)`
    );
    visitsTableEnsured = true;
  } catch (e) {
    console.warn("[visits] 确保 visits 表存在失败（已忽略）：", (e as Error).message);
  }
}

/** 记录一次体验访问。失败只告警、不抛出——埋点绝不能影响登录主流程。 */
export async function recordVisit(input: {
  nickname: string;
  userAgent?: string | null;
  referer?: string | null;
  ip?: string | null;
}): Promise<void> {
  try {
    await ensureVisitsTable();
    await db.insert("visits", {
      nickname: input.nickname,
      user_agent: input.userAgent ?? null,
      referer: input.referer ?? null,
      ip: input.ip ?? null,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("[visits] 记录体验访问失败（已忽略）：", (e as Error).message);
  }
}

export interface VisitSummary {
  /** 累计访问次数（含同一昵称多次进入） */
  totalVisits: number;
  /** 体验人数（去重后的昵称数） */
  uniqueNicknames: number;
  /** 今日访问次数 */
  visitsToday: number;
  /** 访问次数最多的昵称（Top 20） */
  top: Array<{ nickname: string; count: number; lastAt: string }>;
  /** 最近访问明细 */
  recent: Visit[];
  /** 查询失败时的错误信息（无错则 undefined）；用于页面友好提示而非整页 500。 */
  error?: string;
}

/**
 * 聚合体验访问统计。体验期数据量很小，直接拉全量在内存里聚合即可，
 * 无需为统计再引 COUNT/GROUP BY 的下推查询。
 */
export async function getVisitSummary(recentLimit = 100): Promise<VisitSummary> {
  try {
    await ensureVisitsTable();
    const all = await db.findMany<Visit>("visits", { orderBy: [["id", "desc"]] });

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const byNick = new Map<string, { count: number; lastAt: string }>();
    let visitsToday = 0;
    for (const v of all) {
      const at = v.created_at ?? "";
      const cur = byNick.get(v.nickname) ?? { count: 0, lastAt: "" };
      cur.count += 1;
      if (at > cur.lastAt) cur.lastAt = at; // ISO 字符串可直接字典序比较
      byNick.set(v.nickname, cur);
      if (at && new Date(at) >= startOfDay) visitsToday += 1;
    }

    const top = [...byNick.entries()]
      .map(([nickname, v]) => ({ nickname, count: v.count, lastAt: v.lastAt }))
      .sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : -1))
      .slice(0, 20);

    return {
      totalVisits: all.length,
      uniqueNicknames: byNick.size,
      visitsToday,
      top,
      recent: all.slice(0, recentLimit),
    };
  } catch (e) {
    return {
      totalVisits: 0,
      uniqueNicknames: 0,
      visitsToday: 0,
      top: [],
      recent: [],
      error: (e as Error).message,
    };
  }
}
