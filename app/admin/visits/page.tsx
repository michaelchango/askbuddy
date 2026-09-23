// 内部体验统计页：查看有多少人来体验。
// 访问需带口令：/admin/visits?key=<ADMIN_KEY>（在 Vercel 环境变量配置 ADMIN_KEY）。
import { getVisitSummary } from "@/lib/services/visits";

export const dynamic = "force-dynamic";

function fmt(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl p-10 text-[15px] leading-relaxed text-[#111111]">
      <h1 className="mb-4 text-[22px] font-bold">体验统计</h1>
      {children}
    </main>
  );
}

export default async function AdminVisitsPage({
  searchParams,
}: {
  searchParams: { key?: string };
}) {
  const expected = process.env.ADMIN_KEY;

  if (!expected) {
    return (
      <Notice>
        <p>
          未设置访问口令。请在 Vercel 环境变量中配置{" "}
          <code className="rounded bg-[#F2F0EB] px-1.5 py-0.5">ADMIN_KEY</code>，然后以{" "}
          <code className="rounded bg-[#F2F0EB] px-1.5 py-0.5">/admin/visits?key=你的口令</code>{" "}
          访问。
        </p>
      </Notice>
    );
  }

  if (searchParams.key !== expected) {
    return (
      <Notice>
        <p>
          口令不正确。请以{" "}
          <code className="rounded bg-[#F2F0EB] px-1.5 py-0.5">/admin/visits?key=...</code> 访问。
        </p>
      </Notice>
    );
  }

  const s = await getVisitSummary();

  return (
    <main className="mx-auto max-w-3xl p-8 text-[#111111]">
      <h1 className="mb-6 text-[24px] font-bold">体验统计</h1>

      <div className="mb-8 grid grid-cols-3 gap-4">
        <StatCard label="总访问次数" value={s.totalVisits} />
        <StatCard label="体验人数（去重昵称）" value={s.uniqueNicknames} />
        <StatCard label="今日访问" value={s.visitsToday} />
      </div>

      <h2 className="mb-3 text-[17px] font-semibold">最活跃昵称</h2>
      <table className="mb-10 w-full border-collapse text-[14px]">
        <thead>
          <tr className="border-b border-[#E5E2DB] text-left text-[#78746C]">
            <th className="py-2 font-medium">昵称</th>
            <th className="py-2 font-medium">访问次数</th>
            <th className="py-2 font-medium">最近一次</th>
          </tr>
        </thead>
        <tbody>
          {s.top.map((t) => (
            <tr key={t.nickname} className="border-b border-[#F2F0EB]">
              <td className="py-2 font-medium">{t.nickname}</td>
              <td className="py-2">{t.count}</td>
              <td className="py-2 text-[#78746C]">{fmt(t.lastAt)}</td>
            </tr>
          ))}
          {s.top.length === 0 && (
            <tr>
              <td colSpan={3} className="py-4 text-[#78746C]">
                暂无记录
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2 className="mb-3 text-[17px] font-semibold">最近访问明细</h2>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-[#E5E2DB] text-left text-[#78746C]">
            <th className="py-2 font-medium">时间</th>
            <th className="py-2 font-medium">昵称</th>
            <th className="py-2 font-medium">来源</th>
            <th className="py-2 font-medium">设备</th>
          </tr>
        </thead>
        <tbody>
          {s.recent.map((v) => (
            <tr key={v.id} className="border-b border-[#F2F0EB]">
              <td className="whitespace-nowrap py-2">{fmt(v.created_at)}</td>
              <td className="py-2 font-medium">{v.nickname}</td>
              <td className="max-w-[220px] truncate py-2 text-[#78746C]">{v.referer || "—"}</td>
              <td className="max-w-[260px] truncate py-2 text-[#78746C]">{v.user_agent || "—"}</td>
            </tr>
          ))}
          {s.recent.length === 0 && (
            <tr>
              <td colSpan={4} className="py-4 text-[#78746C]">
                暂无记录
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <p className="mt-8 text-[13px] text-[#78746C]">
        说明：本页统计「填昵称进入体验」的次数；页面级流量（PV/UV、来源、设备）请在 Vercel →
        Analytics 查看。
      </p>
    </main>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[13px] border border-[#E5E2DB] bg-white p-4">
      <div className="text-[13px] text-[#78746C]">{label}</div>
      <div className="mt-1 text-[28px] font-bold">{value}</div>
    </div>
  );
}
