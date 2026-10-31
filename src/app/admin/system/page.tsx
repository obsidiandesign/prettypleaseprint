import { requireAdmin } from "@/lib/authz";
import {
  type Build,
  type UpdateCheck,
  checkForUpdate,
  currentBuild,
  packageVersions,
  postgresVersion,
} from "@/lib/build-info";
import { relativeTime } from "@/lib/catalog";
import { AppHeader } from "@/components/app-header";
import { Fact, Kicker, Notice } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * What's running, and whether a newer build is waiting. Admin-only:
 * `requireAdmin` answers 404, because versions describe the infrastructure.
 *
 * "Newer" means a newer release on GitHub's `main`: a commit the release
 * workflow published images for, so the tag it names can be pulled. Package versions are listed for reference. Checking
 * them against npm is left to Dependabot and `npm outdated`, which flag
 * majors this project holds back on purpose.
 */
export default async function SystemPage() {
  const admin = await requireAdmin();
  const build = currentBuild();
  const [update, postgres] = await Promise.all([checkForUpdate(build), postgresVersion()]);
  const packages = packageVersions();

  return (
    <>
      <AppHeader user={admin} active="/admin/system" />

      <main className="mx-auto w-full max-w-[880px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <Kicker>System</Kicker>
        <h1 className="m-0 mt-[6px] mb-[8px] font-display text-[30px] leading-[1.05] text-ink">
          What&rsquo;s running
        </h1>
        <p className="m-0 mb-[22px] max-w-[62ch] text-[15px] text-ink-2">
          The build this server is on, and whether the repository has moved on
          since. To update, set <code className="font-mono text-[13.5px]">PPP_TAG</code>{" "}
          to the newer commit, then pull and bring the stack up.
        </p>

        <div className="mb-[22px]">
          <UpdateNotice update={update} build={build} />
        </div>

        <section className="mb-[22px] grid grid-cols-1 gap-[17.6px] rounded-panel border-[3px] border-ink bg-porcelain p-[17.6px] shadow-stamp sm:grid-cols-2">
          <Fact label="Build">
            {build.tag ? (
              build.repo ? (
                <a
                  href={`https://github.com/${build.repo}/commit/${build.sha}`}
                  className="font-mono underline decoration-2 underline-offset-2"
                >
                  {build.tag}
                </a>
              ) : (
                <span className="font-mono">{build.tag}</span>
              )
            ) : (
              <span className="text-ink-3">Not stamped (a local or CI build)</span>
            )}
          </Fact>
          <Fact label="Built">
            {build.builtAt ? (
              <time dateTime={build.builtAt.toISOString()} title={build.builtAt.toISOString()}>
                {relativeTime(build.builtAt)}
              </time>
            ) : (
              <span className="text-ink-3">—</span>
            )}
          </Fact>
          <Fact label="Node.js">
            <span className="font-mono">{process.version}</span>
          </Fact>
          <Fact label="PostgreSQL">
            <span className="font-mono">{postgres ?? "—"}</span>
          </Fact>
        </section>

        <div className="overflow-x-auto rounded-panel border-[3px] border-ink bg-porcelain shadow-stamp">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-[3px] border-ink bg-cream-2">
                {["Package", "Version"].map((h) => (
                  <th
                    key={h}
                    className="px-[17.6px] py-[11px] text-left font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-ink"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {packages.map((p) => (
                <tr key={p.name} className="border-b-2 border-dashed border-rule last:border-b-0">
                  <td className="px-[17.6px] py-[9px] font-mono text-[12.5px]">{p.name}</td>
                  <td className="px-[17.6px] py-[9px] font-mono text-[12.5px] tabular-nums">{p.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="m-0 mt-[13.2px] font-mono text-[11.5px] uppercase text-ink-3">
          Runtime dependencies, as pinned when this build was made.
        </p>
      </main>
    </>
  );
}

function UpdateNotice({
  update,
  build,
}: {
  update: UpdateCheck;
  build: Build;
}) {
  switch (update.state) {
    case "unstamped":
      return (
        <Notice>
          This build doesn&rsquo;t know its commit, so there&rsquo;s nothing to
          compare. Images from the release workflow do.
        </Notice>
      );
    case "current":
      return (
        <Notice tone="good">
          Up to date with the newest release on{" "}
          <span className="font-mono">{build.repo}</span> main (checked {relativeTime(update.checkedAt)}).
        </Notice>
      );
    case "behind":
      return (
        <Notice tone="warn">
          <strong>Newer build available: {update.latest}</strong>, {update.behindBy} commit
          {update.behindBy === 1 ? "" : "s"} newer than this one. Set{" "}
          <span className="font-mono">PPP_TAG=&quot;{update.latest}&quot;</span>, then pull and
          bring the stack up.{" "}
          <a
            href={`https://github.com/${build.repo}/compare/${build.tag}...${update.latest}`}
            className="underline decoration-2 underline-offset-2"
          >
            See what changed
          </a>
        </Notice>
      );
    case "unknown":
      return (
        <Notice>
          Couldn&rsquo;t check for a newer build: {update.reason}. It tries again
          in a few minutes.
        </Notice>
      );
  }
}
