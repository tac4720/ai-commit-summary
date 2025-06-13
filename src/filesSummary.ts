// PayloadRepository型の代わりに独自のインターフェースを定義
interface PayloadRepository {
  owner: {
    login: string;
  };
  name: string;
}

import { octokit } from "./octokit";
import { MAX_OPEN_AI_QUERY_LENGTH, MAX_TOKENS, MODEL_NAME, openai, TEMPERATURE } from "./openAi";
import { SHARED_PROMPT } from "./sharedPrompt";

const linkRegex =
  /\[(?:[a-f0-9]{6}|None)]\(https:\/\/github\.com\/.*?#([a-f0-9]{40}|None)\)/;

export function preprocessCommitMessage(commitMessage: string): string {
  let match = commitMessage.match(linkRegex);
  while (match !== null) {
    commitMessage = commitMessage.split(match[0]).join(match[1]);
    match = commitMessage.match(linkRegex);
  }
  return commitMessage;
}

const OPEN_AI_PROMPT = `${SHARED_PROMPT}
次に示すのは、1つのファイルに対する git diff です。
この差分で行われた変更内容を高レベルで説明するコメントを作成してください。

以下の形式で出力してください：

    要約: と書いてから、その差分で行われた変更点の要約を箇条書きで記述してください。

    各箇条書きは * で始めてください。

**必ず日本語で出力してください。英語は絶対に使用せず、すべての出力を日本語のみにしてください。**

例：

要約:
* 関数の引数に新しいオプション \`timeout\` を追加
* 不要なログ出力を削除
* コメントを英語から日本語に変更

この形式で、指定された差分の要約を書いてください。
`;

const MAX_FILES_TO_SUMMARIZE = 20;

async function getOpenAISummaryForFile(
  filename: string,
  patch: string
): Promise<string> {
  try {
    const openAIPrompt = `要約するための ${filename} の GIT DIFF：\n\`\`\`\n${patch}\n\`\`\`\n\n要約:\n`;
    console.log(`${filename} のファイル要約プロンプト:\n${openAIPrompt}`);

    if (openAIPrompt.length > MAX_OPEN_AI_QUERY_LENGTH) {
      // noinspection ExceptionCaughtLocallyJS
      throw new Error("OpenAIクエリが大きすぎます");
    }

    const completion = await openai.chat.completions.create({
      model: MODEL_NAME,
      messages: [
        { role: "system", content: OPEN_AI_PROMPT },
        { role: "user", content: openAIPrompt }],
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    });
    if (completion.choices !== undefined && completion.choices.length > 0) {
      return (
        completion.choices[0].message.content ?? "エラー: 要約を生成できませんでした"
      );
    }
  } catch (error) {
    console.error(error);
  }
  return "エラー: 要約を生成できませんでした";
}

async function getReviewComments(
  pullRequestNumber: number,
  repository: PayloadRepository
): Promise<Array<[string, number]>> {
  const reviewComments = (await octokit.paginate(
    octokit.pulls.listReviewComments,
    {
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: pullRequestNumber,
    }
  )) as unknown as Awaited<ReturnType<typeof octokit.pulls.listReviewComments>>;
  return (
    reviewComments as unknown as Array<{ body?: string; id: number }>
  ).map((reviewComment) => [
    preprocessCommitMessage(reviewComment.body ?? ""),
    reviewComment.id,
  ]);
}

export async function getFilesSummaries(
  pullNumber: number,
  repository: PayloadRepository
): Promise<Record<string, string>> {
  const filesChanged = await octokit.pulls.listFiles({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: pullNumber,
  });
  const pullRequest = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: pullNumber,
  });
  const baseCommitSha = pullRequest.data.base.sha;
  const headCommitSha = pullRequest.data.head.sha;
  const baseCommitTree = await octokit.git.getTree({
    owner: repository.owner.login,
    repo: repository.name,
    tree_sha: baseCommitSha,
    recursive: "true",
  });
  const modifiedFiles: Record<
    string,
    {
      sha: string;
      originSha: string;
      diff: string;
      position: number;
      filename: string;
    }
  > = {};
  for (const file of filesChanged.data) {
    const originSha =
      baseCommitTree.data.tree.find((tree: any) => tree.path === file.filename)
        ?.sha ?? "None";
    const firstModifiedLineAfterCommit =
      Number(file.patch?.split("+")[1]?.split(",")[0]) ?? 0;
    modifiedFiles[file.filename] = {
      sha: file.sha,
      originSha,
      diff: file.patch ?? "",
      position: firstModifiedLineAfterCommit,
      filename: file.filename,
    };
  }
  const existingReviewSummaries = (
    await getReviewComments(pullNumber, repository)
  ).filter((comment) => comment[0].startsWith("GPT summary of"));
  let commentIdsToDelete = [...existingReviewSummaries];
  for (const modifiedFile of Object.keys(modifiedFiles)) {
    const expectedComment = `GPT summary of ${modifiedFiles[modifiedFile].originSha} - ${modifiedFiles[modifiedFile].sha}:`;
    commentIdsToDelete = commentIdsToDelete.filter(
      ([comment]) => !comment.includes(expectedComment)
    );
  }
  for (const [, id] of commentIdsToDelete) {
    await octokit.pulls.deleteReviewComment({
      owner: repository.owner.login,
      repo: repository.name,
      comment_id: id,
    });
  }
  const result: Record<string, string> = {};
  let summarizedFiles = 0;
  for (const modifiedFile of Object.keys(modifiedFiles)) {
    if (modifiedFiles[modifiedFile].diff === "") {
      // Binary file
      continue;
    }
    let isFileAlreadySummarized = false;
    const expectedComment = `GPT summary of ${modifiedFiles[modifiedFile].originSha} - ${modifiedFiles[modifiedFile].sha}:`;
    for (const reviewSummary of existingReviewSummaries) {
      if (reviewSummary[0].includes(expectedComment)) {
        result[modifiedFile] = reviewSummary[0].split("\n").slice(1).join("\n");
        isFileAlreadySummarized = true;
        break;
      }
    }
    if (isFileAlreadySummarized) {
      continue;
    }
    const fileAnalysisAndSummary = await getOpenAISummaryForFile(
      modifiedFile,
      modifiedFiles[modifiedFile].diff
    );
    result[modifiedFile] = fileAnalysisAndSummary;
    const comment = `[${modifiedFiles[
      modifiedFile
    ].originSha.slice(0, 6)}](https://github.com/${repository.owner.login}/${
      repository.name
    }/blob/${baseCommitSha}/${modifiedFile}#${
      modifiedFiles[modifiedFile].originSha
    }) - [${modifiedFiles[modifiedFile].sha.slice(0, 6)}](https://github.com/${
      repository.owner.login
    }/${repository.name}/blob/${headCommitSha}/${modifiedFile}#${
      modifiedFiles[modifiedFile].sha}) のGPT要約:\n${fileAnalysisAndSummary}`;
    console.log(
      `${modifiedFiles[modifiedFile].position} 行目にコメントを追加`
    );
    await octokit.pulls.createReviewComment({
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: pullNumber,
      commit_id: headCommitSha,
      path: modifiedFiles[modifiedFile].filename,
      line: Number.isFinite(modifiedFiles[modifiedFile].position)
        ? modifiedFiles[modifiedFile].position > 0
          ? modifiedFiles[modifiedFile].position
          : 1
        : 1,
      side:
        modifiedFiles[modifiedFile].position > 0 ||
        modifiedFiles[modifiedFile].originSha === "None"
          ? "RIGHT"
          : "LEFT",
      body: comment,
    });
    summarizedFiles += 1;
    if (summarizedFiles >= MAX_FILES_TO_SUMMARIZE) {
      break;
    }
  }
  return result;
}
