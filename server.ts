import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

const graphRefSchema = z.object({
  name: z.string(),
  kind: z.enum(["head", "local", "remote", "base", "tag"]),
});

const graphCommitSchema = z.object({
  hash: z.string(),
  shortHash: z.string(),
  parents: z.array(z.string()),
  subject: z.string(),
  author: z.string(),
  authoredAt: z.string(),
  refs: z.array(graphRefSchema),
});

const graphResultSchema = z.object({
  repository: z
    .object({
      name: z.string(),
      path: z.string(),
      branch: z.string().nullable(),
    })
    .nullable(),
  commits: z.array(graphCommitSchema),
  truncated: z.boolean(),
  error: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  gitGraph: {
    input: z
      .object({
        threadId: z.string().min(1),
        offset: z.number().int().min(0).max(199).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
    output: graphResultSchema,
  },
});

export type GitGraphCommit = z.infer<typeof graphCommitSchema>;
export type GitGraphResult = z.infer<typeof graphResultSchema>;

const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";
const BASE_REF_MARKER = "__BB_GIT_GRAPH_BASE_REF__";

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

function parseRefs(value: string): GitGraphCommit["refs"] {
  const refs: GitGraphCommit["refs"] = [];
  const priority = { local: 0, remote: 1, tag: 2, base: 3, head: 4 } as const;

  const addRef = (name: string, kind: GitGraphCommit["refs"][number]["kind"]) => {
    const existing = refs.find((refItem) => refItem.name === name);
    if (!existing) {
      refs.push({ name, kind });
    } else if (priority[kind] > priority[existing.kind]) {
      existing.kind = kind;
    }
  };

  for (const rawRef of value.split(",")) {
    const ref = rawRef.trim();
    if (!ref) continue;

    const remoteHead = ref.match(
      /^refs\/remotes\/[^/]+\/HEAD -> refs\/remotes\/(.+)$/,
    );
    if (remoteHead) {
      addRef(remoteHead[1], "base");
      continue;
    }

    if (ref.startsWith("HEAD -> refs/heads/")) {
      addRef(ref.slice("HEAD -> refs/heads/".length), "head");
    } else if (ref.startsWith("refs/heads/")) {
      addRef(ref.slice("refs/heads/".length), "local");
    } else if (ref.startsWith("refs/remotes/")) {
      const name = ref.slice("refs/remotes/".length);
      if (!name.endsWith("/HEAD")) addRef(name, "remote");
    } else if (ref.startsWith("tag: refs/tags/")) {
      addRef(ref.slice("tag: refs/tags/".length), "tag");
    } else if (ref.startsWith("refs/tags/")) {
      addRef(ref.slice("refs/tags/".length), "tag");
    }
  }

  return refs;
}

export function parseGitLog(output: string, baseRef?: string): GitGraphCommit[] {
  return stripAnsi(output)
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .flatMap((record) => {
      const [hash, parents = "", refs = "", subject = "", author = "", authoredAt = ""] =
        record.split(FIELD_SEPARATOR);
      if (!hash || !/^[0-9a-f]{40,64}$/i.test(hash)) return [];

      return [
        {
          hash,
          shortHash: hash.slice(0, 8),
          parents: parents.split(" ").filter(Boolean),
          subject,
          author,
          authoredAt,
          refs: parseRefs(refs).map((refItem) =>
            refItem.kind === "remote" && refItem.name === baseRef
              ? { ...refItem, kind: "base" as const }
              : refItem,
          ),
        },
      ];
    });
}

function decodeTerminalOutput(
  chunks: Array<{ seq: number; dataBase64: string }>,
): string {
  return [...chunks]
    .sort((left, right) => left.seq - right.seq)
    .map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8"))
    .join("");
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runGitLog(
  bb: BbPluginApi,
  environmentId: string,
  offset: number,
  limit: number,
): Promise<{ output: string; exitCode: number | null }> {
  const format = "%x1e%H%x1f%P%x1f%D%x1f%s%x1f%an%x1f%aI";
  const completionMarker = "__BB_GIT_GRAPH_DONE__";
  const terminal = await bb.sdk.terminals.create({
    scope: { kind: "environment", environmentId },
    cols: 500,
    rows: 24,
    start: { mode: "shell" },
    title: "Git Graph query",
  });

  try {
    let session = terminal;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (session.status === "running") break;
      if (session.status === "exited" || session.status === "disconnected") {
        throw new Error("Git history shell could not be started.");
      }
      await wait(50);
      session = await bb.sdk.terminals.get({ terminalId: terminal.id });
    }

    if (session.status !== "running") {
      throw new Error("Git history shell timed out while starting.");
    }

    await bb.sdk.terminals.input({
      terminalId: terminal.id,
      dataBase64: Buffer.from("stty -echo\n", "utf8").toString("base64"),
    });
    await wait(25);

    const command = [
      `printf '${BASE_REF_MARKER}:%s\\n' "$(git for-each-ref --count=1 --format='%(symref:short)' 'refs/remotes/*/HEAD')"`,
      `git --no-pager log --topo-order --branches --remotes --tags HEAD --decorate=full --no-color --format='${format}' --skip=${offset} --max-count=${limit + 1}`,
      "bb_git_graph_exit=$?",
      `printf '\\n${completionMarker}:%s\\n' "$bb_git_graph_exit"`,
    ].join("; ");
    await bb.sdk.terminals.input({
      terminalId: terminal.id,
      dataBase64: Buffer.from(`${command}\n`, "utf8").toString("base64"),
    });

    let nextSeq = 0;
    let collectedOutput = "";
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const output = await bb.sdk.terminals.output({
        terminalId: terminal.id,
        sinceSeq: nextSeq,
        limitChunks: 10_000,
      });
      collectedOutput += decodeTerminalOutput(output.chunks);
      nextSeq = output.nextSeq;

      const cleanedOutput = stripAnsi(collectedOutput);
      const markerMatch = cleanedOutput.match(
        new RegExp(`${completionMarker}:(\\d+)`),
      );
      if (markerMatch?.index !== undefined) {
        return {
          output: cleanedOutput.slice(0, markerMatch.index),
          exitCode: Number.parseInt(markerMatch[1], 10),
        };
      }

      session = await bb.sdk.terminals.get({ terminalId: terminal.id });
      if (session.status === "exited" || session.status === "disconnected") {
        throw new Error("Git history shell closed before returning output.");
      }
      await wait(50);
    }

    throw new Error("Git history query timed out.");
  } finally {
    await bb.sdk.terminals
      .close({ terminalId: terminal.id, mode: "force" })
      .catch(() => undefined);
  }
}

function graphError(message: string): GitGraphResult {
  return { repository: null, commits: [], truncated: false, error: message };
}

async function loadGraph(
  bb: BbPluginApi,
  threadId: string,
  limit: number,
  offset = 0,
): Promise<GitGraphResult> {
  const thread = await bb.sdk.threads.get({ threadId });
  if (!thread.environmentId) {
    return graphError("This thread does not have a workspace.");
  }

  const environment = await bb.sdk.environments.get({
    environmentId: thread.environmentId,
  });
  if (!environment.isGitRepo || !environment.path) {
    return graphError("This workspace is not a Git repository.");
  }

  try {
    const result = await runGitLog(bb, environment.id, offset, limit);
    const cleanedOutput = stripAnsi(result.output);
    if (result.exitCode !== 0) {
      const message = cleanedOutput.trim().split("\n").slice(-2).join(" ");
      return graphError(message || "Git could not read this repository.");
    }

    const baseRef = cleanedOutput
      .match(new RegExp(`^${BASE_REF_MARKER}:(.*)$`, "m"))?.[1]
      .trim();
    const allCommits = parseGitLog(cleanedOutput, baseRef);
    const commits = allCommits.slice(0, limit);
    const repositoryName = environment.path.split(/[\\/]/).filter(Boolean).at(-1) ?? environment.path;

    return {
      repository: {
        name: repositoryName,
        path: environment.path,
        branch: environment.branchName,
      },
      commits,
      truncated: allCommits.length > limit,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Git history could not be loaded.";
    bb.log.warn(`graph query failed for ${threadId}: ${message}`);
    return graphError(message);
  }
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  bb.rpc.register(rpcContract, {
    async gitGraph({ threadId, offset = 0, limit = 50 }) {
      const cappedLimit = Math.min(limit, 200 - offset);
      return loadGraph(bb, threadId, cappedLimit, offset);
    },
  });

  bb.cli.register({
    name: "git-graph",
    summary: "Inspect the Git commit graph for a bb thread",
    commands: [
      {
        name: "show",
        summary: "Print recent commits for the current thread",
        usage: "bb git-graph show [limit]",
      },
    ],
    async run(argv, context) {
      if (!context.threadId) {
        return { exitCode: 2, stderr: "Run this command from a bb thread." };
      }

      const requested = argv[0] === "show" ? argv[1] : argv[0];
      const limit = requested ? Number.parseInt(requested, 10) : 30;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return { exitCode: 2, stderr: "Limit must be an integer from 1 to 200." };
      }

      const graph = await loadGraph(bb, context.threadId, limit);
      if (graph.error) return { exitCode: 1, stderr: graph.error };

      return {
        exitCode: 0,
        stdout: graph.commits
          .slice(0, limit)
          .map((commit) => `${commit.shortHash}  ${commit.subject}  (${commit.author})`)
          .join("\n"),
      };
    },
  });

  bb.onDispose(() => bb.log.info("disposed"));
}
