#!/usr/bin/env node
/**
 * GitHub Project 管理工具（scripts/gh-project.mjs，v0.23.2）
 * 通过 GitHub API 管理「MUST登校」项目板（user project #2）与仓库 issue。
 *
 * 用法：
 *   node scripts/gh-project.mjs list
 *       列出项目板卡片（内容 + 状态）
 *   node scripts/gh-project.mjs backlog "<标题>" ["<正文>"]
 *       建 issue → 入板 → 状态 Backlog（待办）
 *   node scripts/gh-project.mjs release "<标题>" ["<正文>"]
 *       建 issue → 立即关闭 → 入板 Done（发版留档，一步到位）
 *   node scripts/gh-project.mjs done <issue编号> [<issue编号>...]
 *       把已有 issue 入板并设为 Done（发版留档）
 *   node scripts/gh-project.mjs review <pr编号> [<pr编号>...]
 *       把 PR 卡设 In review
 *
 * token 来源：环境变量 GHT，或自动从本机 git 凭据读取（需含 project scope）。
 */
import { execSync } from "node:child_process";

const REPO = "Bill68Wong/musttoukou";
const PROJECT_NUMBER = 2;

function token() {
  if (process.env.GHT) return process.env.GHT;
  try {
    // 经 stdin 喂入、不走 shell：免去 bash 依赖（cmd/PowerShell 直接跑也行），
    // 也避开 printf/重定向在不同 shell 下的转义坑
    const out = execSync("git credential fill", {
      encoding: "utf8",
      input: "protocol=https\nhost=github.com\n\n",
    });
    const m = out.match(/^password=(.+)$/m);
    if (m) return m[1].trim();
  } catch {
    /* ignore */
  }
  throw new Error(
    "未找到 GitHub token。三种办法任选：\n" +
      "  ① 在 Git Bash 里跑本脚本（凭据助手在 Git Bash 下最稳）\n" +
      "  ② 先取凭据再传环境变量：GHT=<token> node scripts/gh-project.mjs ...\n" +
      "  ③ 若报 PROGRAM BLOCKED ... wsl.exe：git 凭据助手会拉起 wsl，请到「安全中心 → 命令安全 → 程序黑名单」移除 wsl.exe",
  );
}
const T = token();

const rest = async (path, method = "GET", body) => {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${T}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(d).slice(0, 220)}`);
  return d;
};
const gql = async (query, variables) => {
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${T}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const d = await r.json();
  if (d.errors) throw new Error("GraphQL " + JSON.stringify(d.errors).slice(0, 320));
  return d.data;
};

async function projectCtx() {
  const d = await gql(
    `query{ user(login:"Bill68Wong"){ projectV2(number:${PROJECT_NUMBER}){ id fields(first:20){ nodes{ __typename ... on ProjectV2SingleSelectField { id name options{id name} } } } } } }`,
  );
  const p = d.user.projectV2;
  const status = p.fields.nodes.find((f) => f.name === "Status");
  return { pid: p.id, statusFieldId: status.id, optId: (n) => status.options.find((o) => o.name === n).id };
}

async function setStatus(ctx, contentId, statusName) {
  const add = await gql(
    `mutation($pid:ID!,$cid:ID!){ addProjectV2ItemById(input:{projectId:$pid,contentId:$cid}){ item{ id } } }`,
    { pid: ctx.pid, cid: contentId },
  );
  const itemId = add.addProjectV2ItemById.item.id;
  await gql(
    `mutation($pid:ID!,$iid:ID!,$fid:ID!,$v:String!){ updateProjectV2ItemFieldValue(input:{projectId:$pid,itemId:$iid,fieldId:$fid,value:{singleSelectOptionId:$v}}){ projectV2Item{ id } } }`,
    { pid: ctx.pid, iid: itemId, fid: ctx.statusFieldId, v: ctx.optId(statusName) },
  );
  return itemId;
}

const [cmd, ...args] = process.argv.slice(2);
const ctx = await projectCtx();

/** 建 issue（返回 REST 原始对象，含 number / node_id） */
const createIssue = (title, body) => rest(`/repos/${REPO}/issues`, "POST", { title, body });

/** 关闭 issue 并置入 Done（backlog/done/release 共用的收尾动作） */
async function closeAndDone(n) {
  const iss = await rest(`/repos/${REPO}/issues/${n}`);
  if (iss.state !== "closed") await rest(`/repos/${REPO}/issues/${n}`, "PATCH", { state: "closed" });
  await setStatus(ctx, iss.node_id, "Done");
  return iss;
}

if (cmd === "list") {
  const d = await gql(
    `query($pid:ID!){ node(id:$pid){ ... on ProjectV2 { items(first:50){ nodes{ id fieldValues(first:20){ nodes{ __typename ... on ProjectV2ItemFieldSingleSelectValue { name field{ ... on ProjectV2SingleSelectField { name } } } } } content{ __typename ... on Issue{ number title state } ... on PullRequest{ number title state } } } } } } }`,
    { pid: ctx.pid },
  );
  for (const it of d.node.items.nodes) {
    const st = it.fieldValues.nodes.find((v) => v.field?.name === "Status")?.name ?? "?";
    const c = it.content;
    console.log(
      `  [${st}] ${c ? `${c.__typename}#${c.number} ${c.title}` : "(note)"}${c?.state === "CLOSED" ? " (closed)" : ""}`,
    );
  }
} else if (cmd === "backlog") {
  const [title, body = ""] = args;
  if (!title) throw new Error("缺少标题");
  const iss = await createIssue(title, body);
  await setStatus(ctx, iss.node_id, "Backlog");
  console.log(`✅ #${iss.number} 入板 Backlog：${title}`);
} else if (cmd === "release") {
  // 发版留档：建卡即关闭并进 Done（等价于 backlog + done 两步，省一次复制编号）
  const [title, body = ""] = args;
  if (!title) throw new Error("缺少标题");
  const iss = await createIssue(title, body);
  const done = await closeAndDone(iss.number);
  console.log(`✅ #${done.number} 建卡即归档 Done：${done.title}`);
} else if (cmd === "done") {
  for (const n of args) {
    const iss = await closeAndDone(n);
    console.log(`✅ #${n} 已关闭并入板 Done：${iss.title}`);
  }
} else if (cmd === "review") {
  for (const n of args) {
    const pr = await rest(`/repos/${REPO}/pulls/${n}`);
    await setStatus(ctx, pr.node_id, "In review");
    console.log(`✅ PR#${n} 入板 In review：${pr.title}`);
  }
} else {
  console.log(
    "用法：list | backlog <标题> [正文] | release <标题> [正文] | done <issue编号...> | review <PR编号...>",
  );
}
