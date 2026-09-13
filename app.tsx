import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRpc,
  type PluginThreadHeaderActionProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type {
  GitGraphCommit,
  GitGraphRepository,
  GitGraphResult,
  rpcContract,
} from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

type GraphLane = {
  hash: string;
  color: string;
};

type GraphRow = GitGraphCommit & {
  before: GraphLane[];
  after: GraphLane[];
  lane: number;
  color: string;
};

const VSCODE_GRAPH_COLORS = [
  "#FFB000",
  "#DC267F",
  "#994F00",
  "#40B0A6",
  "#B66DFF",
];
const VSCODE_CURRENT_REF_COLOR = "#59A4F9";
const VSCODE_BASE_REF_COLOR = "#EA5C00";
const BADGE_DARK_TEXT = "#1F1F1F";
const BADGE_LIGHT_TEXT = "#FFFFFF";
const FORCED_LIGHT_BADGE_TEXT_COLORS = new Set([
  VSCODE_CURRENT_REF_COLOR,
  "#40B0A6",
  "#B66DFF",
]);
const LANE_GAP = 14;
const GRAPH_PADDING = 13;
const GRAPH_TRAILING_SPACE = 18;
const GRAPH_CURVE_OFFSET = 6;
const ROW_HEIGHT = 26;
const PAGE_SIZE = 50;
const MAX_COMMITS = 200;
const LOAD_MORE_THRESHOLD = 240;

function refLaneColor(commit: GitGraphCommit): string | undefined {
  if (commit.refs.some((refItem) => refItem.kind === "head")) {
    return VSCODE_CURRENT_REF_COLOR;
  }

  if (commit.refs.some((refItem) => refItem.kind === "base")) {
    return VSCODE_BASE_REF_COLOR;
  }

  const remoteRef = commit.refs.find((refItem) => refItem.kind === "remote");
  if (remoteRef && /(^|\/)(main|master)$/.test(remoteRef.name)) {
    return VSCODE_BASE_REF_COLOR;
  }

  return undefined;
}

function buildRows(commits: GitGraphCommit[]): GraphRow[] {
  let lanes: GraphLane[] = [];
  let nextColor = 0;

  const allocateColor = () => {
    const color = VSCODE_GRAPH_COLORS[nextColor];
    nextColor = (nextColor + 1) % VSCODE_GRAPH_COLORS.length;
    return color;
  };

  return commits.map((commit) => {
    const refColor = refLaneColor(commit);
    let lane = lanes.findIndex((item) => item.hash === commit.hash);
    if (lane === -1) {
      lane = 0;
      lanes = [
        { hash: commit.hash, color: refColor ?? allocateColor() },
        ...lanes,
      ];
    }

    const currentLane = lanes[lane];
    const color = refColor ?? currentLane.color;
    const before = [...lanes];
    const after = lanes.filter((item) => item.hash !== commit.hash);
    let insertionIndex = Math.min(lane, after.length);

    commit.parents.forEach((parent, parentIndex) => {
      if (after.some((item) => item.hash === parent)) return;
      after.splice(insertionIndex, 0, {
        hash: parent,
        color: parentIndex === 0 ? color : allocateColor(),
      });
      insertionIndex += 1;
    });

    lanes = after;
    return { ...commit, before, after, lane, color };
  });
}

function laneX(lane: number): number {
  return GRAPH_PADDING + lane * LANE_GAP;
}

function relativeLuminance(color: string): number | null {
  const match = color.match(/^#([0-9a-f]{6})$/i);
  if (!match) return null;

  const channels = match[1].match(/.{2}/g)?.map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  if (!channels || channels.length !== 3) return null;

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first: number, second: number): number {
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

function badgeTextColor(backgroundColor: string): string {
  if (FORCED_LIGHT_BADGE_TEXT_COLORS.has(backgroundColor.toUpperCase())) {
    return BADGE_LIGHT_TEXT;
  }

  const backgroundLuminance = relativeLuminance(backgroundColor);
  const darkTextLuminance = relativeLuminance(BADGE_DARK_TEXT);
  if (backgroundLuminance === null || darkTextLuminance === null) {
    return BADGE_DARK_TEXT;
  }

  return contrastRatio(backgroundLuminance, 1) >=
    contrastRatio(backgroundLuminance, darkTextLuminance)
    ? BADGE_LIGHT_TEXT
    : BADGE_DARK_TEXT;
}

function GraphCell({ row, isFirst }: { row: GraphRow; isFirst: boolean }) {
  const centerY = ROW_HEIGHT / 2;
  const laneCount = Math.max(row.before.length, row.after.length, 1);
  const width = laneX(laneCount - 1) + GRAPH_TRAILING_SPACE;

  return (
    <svg
      aria-hidden="true"
      className="shrink-0 overflow-visible"
      height={ROW_HEIGHT}
      width={width}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
    >
      {row.before.map((source, sourceLane) => {
        if (sourceLane === row.lane) {
          return isFirst ? null : (
            <line
              key={`incoming-${source.hash}`}
              stroke={source.color}
              x1={laneX(sourceLane)}
              x2={laneX(sourceLane)}
              y1={0}
              y2={centerY}
              strokeLinecap="round"
              strokeWidth={2}
            />
          );
        }

        const destinationLane = row.after.findIndex(
          (item) => item.hash === source.hash,
        );
        if (destinationLane === -1) return null;
        return (
          <path
            key={`carry-${source.hash}-${sourceLane}`}
            stroke={source.color}
            d={`M ${laneX(sourceLane)} 0 C ${laneX(sourceLane)} ${centerY}, ${laneX(destinationLane)} ${centerY}, ${laneX(destinationLane)} ${ROW_HEIGHT}`}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
          />
        );
      })}

      {row.parents.map((parent, parentIndex) => {
        const destinationLane = row.after.findIndex(
          (item) => item.hash === parent,
        );
        if (destinationLane === -1) return null;
        const color =
          parentIndex === 0 ? row.color : row.after[destinationLane].color;
        return (
          <path
            key={`parent-${parent}`}
            stroke={color}
            d={`M ${laneX(row.lane)} ${centerY} C ${laneX(row.lane)} ${centerY + GRAPH_CURVE_OFFSET}, ${laneX(destinationLane)} ${centerY + GRAPH_CURVE_OFFSET}, ${laneX(destinationLane)} ${ROW_HEIGHT}`}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
          />
        );
      })}

      <circle
        className={row.parents.length > 1 ? "fill-background" : undefined}
        cx={laneX(row.lane)}
        cy={centerY}
        fill={row.parents.length > 1 ? undefined : row.color}
        r={row.parents.length > 1 ? 5 : 4}
        stroke={row.color}
        strokeWidth={2}
      />
    </svg>
  );
}

function RefBadge({
  refItem,
  laneColor,
}: {
  refItem: GitGraphCommit["refs"][number];
  laneColor: string;
}) {
  return (
    <span
      className="inline-flex h-5 max-w-48 items-center gap-1 truncate rounded px-1.5 text-[11px] font-medium"
      style={{ backgroundColor: laneColor, color: badgeTextColor(laneColor) }}
    >
      <Icon name={refItem.kind === "tag" ? "Star" : "GitBranch"} className="size-3 shrink-0" />
      <span className="truncate">{refItem.name}</span>
    </span>
  );
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

function EmptyGraph({ message }: { message: string }) {
  return (
    <div className="flex min-h-48 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <Icon name="GitBranch" className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function GitGraphPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [repositories, setRepositories] = useState<GitGraphRepository[]>([]);
  const [selectedRepositoryPath, setSelectedRepositoryPath] = useState<
    string | null
  >(null);
  const [result, setResult] = useState<GitGraphResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [appendError, setAppendError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(0);
  const loadingRef = useRef(false);
  const generationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    generationRef.current += 1;
    loadingRef.current = false;
    setRepositories([]);
    setSelectedRepositoryPath(null);
    setResult(null);
    setAppendError(null);
    setIsLoading(true);

    void rpc
      .call("gitRepositories", { threadId })
      .then((nextResult) => {
        if (cancelled) return;
        setRepositories(nextResult.repositories);

        const primaryRepository =
          nextResult.repositories.find((repository) => repository.isPrimary) ??
          nextResult.repositories[0];
        if (primaryRepository) {
          setSelectedRepositoryPath(primaryRepository.path);
          return;
        }

        setResult({
          repository: null,
          commits: [],
          truncated: false,
          error: nextResult.error ?? "No Git repositories were found.",
        });
        setIsLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setResult({
          repository: null,
          commits: [],
          truncated: false,
          error:
            error instanceof Error
              ? error.message
              : "Git repositories could not be loaded.",
        });
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [rpc, threadId]);

  const refresh = useCallback(() => {
    generationRef.current += 1;
    loadingRef.current = false;
    setRequestId((value) => value + 1);
  }, []);

  const selectRepository = useCallback(
    (repositoryPath: string) => {
      if (repositoryPath === selectedRepositoryPath) return;
      generationRef.current += 1;
      loadingRef.current = false;
      setSelectedRepositoryPath(repositoryPath);
      setResult(null);
      setAppendError(null);
      setIsLoading(true);
    },
    [selectedRepositoryPath],
  );

  useEffect(() => {
    if (!selectedRepositoryPath) return;

    let cancelled = false;
    const generation = generationRef.current;
    loadingRef.current = true;
    setIsLoading(true);
    setAppendError(null);
    setResult(null);
    void rpc
      .call("gitGraph", {
        threadId,
        repositoryPath: selectedRepositoryPath,
        offset: 0,
        limit: PAGE_SIZE,
      })
      .then((nextResult) => {
        if (!cancelled && generation === generationRef.current) {
          setResult(nextResult);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled && generation === generationRef.current) {
          setResult({
            repository: null,
            commits: [],
            truncated: false,
            error: error instanceof Error ? error.message : "Git history could not be loaded.",
          });
        }
      })
      .finally(() => {
        if (!cancelled && generation === generationRef.current) {
          loadingRef.current = false;
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [requestId, rpc, selectedRepositoryPath, threadId]);

  const canLoadMore = Boolean(
    result &&
      !result.error &&
      result.truncated &&
      result.commits.length < MAX_COMMITS,
  );

  const loadMore = useCallback(() => {
    if (
      !result ||
      !selectedRepositoryPath ||
      !canLoadMore ||
      loadingRef.current
    ) {
      return;
    }

    const offset = result.commits.length;
    const limit = Math.min(PAGE_SIZE, MAX_COMMITS - offset);
    const generation = generationRef.current;
    loadingRef.current = true;
    setIsLoading(true);
    setAppendError(null);

    void rpc
      .call("gitGraph", {
        threadId,
        repositoryPath: selectedRepositoryPath,
        offset,
        limit,
      })
      .then((page) => {
        if (generation !== generationRef.current) return;
        if (page.error) {
          setAppendError(page.error);
          setResult((current) => current ? { ...current, truncated: false } : page);
          return;
        }

        setResult((current) => {
          if (!current || current.commits.length !== offset) return current;
          const commits = [...current.commits, ...page.commits].slice(0, MAX_COMMITS);
          return {
            repository: current.repository ?? page.repository,
            commits,
            truncated: page.truncated && commits.length < MAX_COMMITS,
            error: null,
          };
        });
      })
      .catch((error: unknown) => {
        if (generation !== generationRef.current) return;
        setAppendError(
          error instanceof Error ? error.message : "More commits could not be loaded.",
        );
        setResult((current) => current ? { ...current, truncated: false } : current);
      })
      .finally(() => {
        if (generation === generationRef.current) {
          loadingRef.current = false;
          setIsLoading(false);
        }
      });
  }, [canLoadMore, result, rpc, selectedRepositoryPath, threadId]);

  const rows = useMemo(() => buildRows(result?.commits ?? []), [result?.commits]);
  const selectedRepository = useMemo(
    () =>
      repositories.find(
        (repository) => repository.path === selectedRepositoryPath,
      ) ?? null,
    [repositories, selectedRepositoryPath],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="min-w-0 flex-1">
          {repositories.length > 1 && selectedRepositoryPath ? (
            <label className="relative inline-flex h-5 max-w-full cursor-pointer items-center gap-1 rounded px-0.5 text-sm font-medium hover:bg-state-hover focus-within:ring-1 focus-within:ring-ring">
              <Icon
                name="Laptop"
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="truncate">
                {selectedRepository?.name ?? "Repository graph"}
              </span>
              <Icon
                name="ChevronDown"
                className="size-3 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <select
                aria-label="Repository"
                className="absolute inset-0 size-full cursor-pointer opacity-0"
                value={selectedRepositoryPath}
                onChange={(event) => selectRepository(event.target.value)}
              >
                {repositories.map((repository) => (
                  <option key={repository.path} value={repository.path}>
                    {repository.name}  {repository.path}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="flex min-w-0 items-center gap-1 text-sm font-medium">
              <Icon
                name="Laptop"
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="truncate">
                {selectedRepository?.name ?? result?.repository?.name ?? "Repository graph"}
              </span>
            </div>
          )}
          {result?.repository?.branch ? (
            <div className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
              <Icon name="GitBranch" className="size-3" aria-hidden="true" />
              <span className="truncate">{result.repository.branch}</span>
            </div>
          ) : null}
        </div>
        {result ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {result.commits.length} / {MAX_COMMITS}
          </span>
        ) : null}
        <Button
          aria-label="Refresh Git graph"
          className="size-7"
          disabled={isLoading}
          size="icon"
          variant="ghost"
          onClick={refresh}
        >
          <Icon name={isLoading ? "Spinner" : "RotateCcw"} className={isLoading ? "animate-spin" : ""} />
        </Button>
      </div>

      {isLoading && !result ? (
        <EmptyGraph message="Loading commit history..." />
      ) : result?.error ? (
        <EmptyGraph message={result.error} />
      ) : rows.length === 0 ? (
        <EmptyGraph message="No commits found in this repository." />
      ) : (
        <div
          className="min-h-0 flex-1 overflow-auto"
          onScroll={(event) => {
            const target = event.currentTarget;
            if (
              target.scrollHeight - target.scrollTop - target.clientHeight <=
              LOAD_MORE_THRESHOLD
            ) {
              loadMore();
            }
          }}
        >
          <div className="min-w-full py-1">
            {rows.map((row, index) => (
              <div
                className="flex min-w-0 items-stretch pr-3 hover:bg-state-hover"
                key={row.hash}
                style={{ height: ROW_HEIGHT }}
              >
                <GraphCell row={row} isFirst={index === 0} />
                <div className="flex min-w-64 flex-1 items-center overflow-hidden">
                  <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                    <span className="truncate text-sm font-medium leading-5">
                      {row.subject}
                    </span>
                    {row.refs.map((refItem) => (
                      <RefBadge
                        key={`${refItem.kind}-${refItem.name}`}
                        laneColor={row.color}
                        refItem={refItem}
                      />
                    ))}
                  </div>
                  <div className="ml-2 flex max-w-48 shrink-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
                    <span className="truncate">{row.author}</span>
                    <span className="shrink-0">{relativeTime(row.authoredAt)}</span>
                  </div>
                </div>
              </div>
            ))}
            {isLoading ? (
              <div className="flex h-10 items-center justify-center text-muted-foreground">
                <Icon name="Spinner" className="size-4 animate-spin" aria-label="Loading more commits" />
              </div>
            ) : appendError ? (
              <div className="flex h-10 items-center justify-center px-4 text-xs text-destructive">
                {appendError}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function GitGraphHeaderAction({ isCompactViewport }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  return (
    <Button
      aria-label="Open Git graph"
      className={isCompactViewport ? "size-7" : "h-7 gap-1.5 px-2 text-xs"}
      size={isCompactViewport ? "icon" : "sm"}
      variant="ghost"
      onClick={() => navigate.openThreadPanel({ actionId: "git-graph", title: "Git Graph" })}
    >
      <Icon name="GitBranch" />
      {isCompactViewport ? null : <span>Graph</span>}
    </Button>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "git-graph",
    title: "Git Graph",
    icon: "GitBranch",
    layout: "flush",
    component: GitGraphPanel,
  });

  app.slots.experimental_threadHeaderAction({
    id: "git-graph-header",
    title: "Git Graph",
    component: GitGraphHeaderAction,
  });
});
