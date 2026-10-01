import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { requireUser } from "@/lib/rbac/server";
import { aiAvailable } from "@/lib/ai";
import { getSlackContext } from "@/lib/slack/config";
import { prepTargets } from "@/lib/briefs/one-on-one";
import { isLeader, listPosts, pendingStoryPrompts, playbookTagCounts } from "@/lib/team/queries";
import { storyComposerData } from "@/lib/team/stories";
import { PLAYBOOK_TAG_LABELS, PLAYBOOK_TAGS, POST_KINDS, type PlaybookTag, type PostKind } from "@/lib/team/story-core";
import { ROLE_LABELS, type Role } from "@/lib/rbac/model";
import { Avatar, EmptyState, PageHeader } from "@/components/ui/misc";
import { TabNav, type TabDef } from "@/components/tasks/tab-nav";
import { PostCard } from "@/components/team/post-card";
import { StoryComposer } from "@/components/team/story-composer";
import { AnnouncementComposer } from "@/components/team/announcement-composer";
import { FilterChips } from "@/components/team/feed-filters";
import { PlaybookSearch } from "@/components/team/playbook-search";
import { StoryPrompts } from "@/components/team/story-prompts";

export const metadata = { title: "Team" };

const UUID = /^[0-9a-f-]{36}$/i;
const KIND_LABELS: Record<PostKind, string> = { win: "Wins", loss: "Lessons", announcement: "Announcements", clip: "Clips" };
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function TeamPage({ searchParams }: PageProps<"/team">) {
  const user = await requireUser();
  const slackReady = Boolean(await getSlackContext().catch(() => null)); // QA MIN-38
  const sp = await searchParams;
  const share = one(sp.share);
  const [targets, prompts, composer] = await Promise.all([
    prepTargets(user),
    pendingStoryPrompts(user, 5).catch(() => []),
    share && UUID.test(share) ? storyComposerData(user, share) : Promise.resolve(null),
  ]);
  const tabs: TabDef[] = [
    { key: "feed", label: "Feed" },
    { key: "playbook", label: "Playbook" },
    ...(targets.length ? [{ key: "1-1", label: "1:1 prep", count: targets.filter((t) => t.direct).length || undefined }] : []),
  ];
  const tabParam = one(sp.tab);
  const tab = tabs.some((t) => t.key === tabParam) ? tabParam! : "feed";

  let body: React.ReactNode;
  if (tab === "playbook") {
    const tagParam = one(sp.tag);
    const tag = (PLAYBOOK_TAGS as readonly string[]).includes(tagParam ?? "") ? (tagParam as PlaybookTag) : null;
    const q = one(sp.q)?.slice(0, 100) ?? "";
    const [{ posts }, counts] = await Promise.all([listPosts(user, { playbook: true, tag, q, limit: 60 }), playbookTagCounts(user)]);
    const href = (t: string | null) => `/team?tab=playbook${t ? `&tag=${t}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
    body = (
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <FilterChips
            label="Playbook tags"
            active={tag ?? "all"}
            chips={[{ key: "all", label: "All", href: href(null), count: counts.all }, ...PLAYBOOK_TAGS.map((t) => ({ key: t, label: PLAYBOOK_TAG_LABELS[t], href: href(t), count: counts[t] }))]}
          />
          <PlaybookSearch initial={q} />
        </div>
        {posts.length ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {posts.map((p) => (
              <PostCard key={p.id} post={p} compact />
            ))}
          </div>
        ) : (
          <EmptyState
            title={q || tag ? "Nothing matches" : "The playbook is empty — for now"}
            description={
              q || tag
                ? "Try another tag or search."
                : "Open a call, select the exact words that landed, and choose “Add to playbook”. Leaders can also add win stories from the feed."
            }
            action={
              q || tag ? (
                <Link href="/team?tab=playbook" className="text-sm text-fg underline-offset-4 hover:underline">
                  Clear filters
                </Link>
              ) : (
                <Link href="/calls" className="text-sm text-fg underline-offset-4 hover:underline">
                  Go to calls
                </Link>
              )
            }
          />
        )}
      </div>
    );
  } else if (tab === "1-1") {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-muted">A fresh brief each week: movement, wins and losses, slipped commitments, activity vs last week, risks and three coaching prompts.</p>
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1">
          {targets.map((t) => (
            <li key={t.id}>
              <Link href={`/team/1-1/${t.id}`} className="group flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-surface-2">
                <Avatar name={t.name} src={t.image} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">{t.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {t.title ?? ROLE_LABELS[t.role as Role] ?? t.role}
                    {t.direct ? " · reports to you" : ""}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1 text-xs text-secondary group-hover:text-fg">
                  Prep 1:1 <ArrowRight className="size-3.5" aria-hidden />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  } else {
    const kindParam = one(sp.kind);
    const kind = (POST_KINDS as readonly string[]).includes(kindParam ?? "") ? (kindParam as PostKind) : null;
    const beforeParam = one(sp.before);
    const before = beforeParam && !Number.isNaN(Date.parse(beforeParam)) ? new Date(beforeParam) : null;
    const { posts, nextBefore } = await listPosts(user, { kind, before, limit: 30 });
    const href = (k: string | null) => `/team${k ? `?kind=${k}` : ""}`;
    body = (
      <div className="space-y-4">
        <StoryPrompts prompts={prompts} />
        <FilterChips label="Post types" active={kind ?? "all"} chips={[{ key: "all", label: "Everything", href: href(null) }, ...POST_KINDS.map((k) => ({ key: k, label: KIND_LABELS[k], href: href(k) }))]} />
        {posts.length ? (
          <div className="mx-auto max-w-2xl space-y-3">
            {posts.map((p) => (
              <PostCard key={p.id} post={p} />
            ))}
            <div className="flex justify-center gap-4 pt-2 text-sm">
              {before ? (
                <Link href={href(kind)} className="text-secondary hover:text-fg">
                  Back to latest
                </Link>
              ) : null}
              {nextBefore ? (
                <Link href={`/team?${kind ? `kind=${kind}&` : ""}before=${encodeURIComponent(nextBefore)}`} className="text-secondary hover:text-fg">
                  Older posts
                </Link>
              ) : null}
            </div>
          </div>
        ) : (
          <EmptyState
            title={kind || before ? "Nothing here yet" : "The feed is quiet"}
            description={
              kind || before
                ? "No posts of this kind."
                : "When a deal closes, its owner gets a ready-made story draft in Today. Wins, lessons and great call moments show up here."
            }
            action={
              kind || before ? (
                <Link href="/team" className="text-sm text-fg underline-offset-4 hover:underline">
                  Show everything
                </Link>
              ) : undefined
            }
          />
        )}
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Team" description="Wins, lessons and the plays that work." actions={isLeader(user) ? <AnnouncementComposer slackReady={slackReady} /> : undefined} />
      {share && !composer ? (
        <p role="status" className="mb-4 rounded-md border border-border-strong bg-surface-1 px-3 py-2 text-sm text-secondary">
          That story isn&apos;t available — the deal may have been reopened, or you don&apos;t have access to it.
        </p>
      ) : null}
      <TabNav tabs={tabs} active={tab} basePath="/team" />
      <div className="pt-5">{body}</div>
      {composer ? <StoryComposer key={composer.dealId} data={composer} aiEnabled={aiAvailable()} slackReady={slackReady} /> : null}
    </div>
  );
}
