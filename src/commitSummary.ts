import type { gitDiffMetadata } from "./DiffMetadata";
import { octokit } from "./octokit";
import { MAX_OPEN_AI_QUERY_LENGTH, MAX_TOKENS, MODEL_NAME, openai, TEMPERATURE } from "./openAi";
import { SHARED_PROMPT } from "./sharedPrompt";
import { summarizePr } from "./summarizePr";

const OPEN_AI_PRIMING = `${SHARED_PROMPT}
最初のファイルの git diff の後には空行があり、その後に次のファイルの git diff が続きます。

1つまたは2つのファイルの変更に関するコメントには、
コメントの末尾に [path/to/modified/python/file.py], [path/to/another/file.json]
のようにファイル名を追加してください。
変更されたファイルが3つ以上ある場合は、ファイル名をその形式で付けないでください。

ファイル名はコメント内の他の場所に含めず、必ず指定された形式で末尾にのみ記載してください。
また、\`[\` や \`]\` の文字は上記以外の目的では使用しないでください。

各コメントは新しい行に記載してください。
コメントはすべて箇条書きとし、各行の先頭に \`*\` を付けてください。

コメントにはコード内のコメントをそのままコピーして含めてはいけません。
出力は読みやすさを最優先とし、コメントの数は少なめにして重要な点のみに絞ってください。
迷ったら書かない方が良いです。

**読みやすさが最も重要です。**

diff に関して本当に重要な点だけを記述してください。

**必ず日本語で出力してください。英語は使用せず、すべての出力を日本語のみにしてください。**

### 要約コメントの例：
\`\`\`
* 返される録音数を \`10\` から \`100\` に増加 [packages/server/recordings_api.ts], [packages/server/constants.ts]
* GitHub Action 名のタイポを修正 [.github/workflows/ai-commit-summary.yml]
* \`octokit\` の初期化処理を別ファイルに分離 [src/octokit.ts], [src/index.ts]
* OpenAI の Completions API を追加 [packages/utils/apis/openai.ts]
* テストファイルの数値許容誤差を引き下げ
\`\`\`

多くのコミットでは、上記の例よりもコメント数は少なくなるはずです。
最後のコメントには関係するファイルが3つ以上あったため、ファイル名は含まれていません。

この例の文言をそのまま出力に含めないでください。
あくまで「適切なコメントの形式」の参考として記載しています。
`;

const MAX_COMMITS_TO_SUMMARIZE = 20;

function formatGitDiff(filename: string, patch: string): string {
  const result = [];
  result.push(`--- a/${filename}`);
  result.push(`+++ b/${filename}`);
  for (const line of patch.split("\n")) {
    result.push(line);
  }
  result.push("");
  return result.join("\n");
}

function postprocessSummary(
  filesList: string[],
  summary: string,
  diffMetadata: gitDiffMetadata
): string {
  for (const fileName of filesList) {
    const splitFileName = fileName.split("/");
    const shortName = splitFileName[splitFileName.length - 1];
    const link =
      "https://github.com/" +
      `${diffMetadata.repository.owner.login}/` +
      `${diffMetadata.repository.name}/blob/` +
      `${diffMetadata.commit.data.sha}/` +
      `${fileName}`;
    summary = summary.split(`[${fileName}]`).join(`[${shortName}](${link})`);
  }
  return summary;
}

async function getOpenAICompletion(
  comparison: Awaited<ReturnType<typeof octokit.repos.compareCommits>>,
  completion: string,
  diffMetadata: gitDiffMetadata
): Promise<string> {
  try {
    const diffResponse = await octokit.request(comparison.url);

    const rawGitDiff = diffResponse.data.files
      .map((file: any) => formatGitDiff(file.filename, file.patch))
      .join("\n");
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    const openAIPrompt = `THE GIT DIFF TO BE SUMMARIZED:\n\`\`\`\n${rawGitDiff}\n\`\`\`\n\nTHE SUMMERY:\n`;

    console.log(
      `コミット ${diffMetadata.commit.data.sha} のためのOpenAIプロンプト: ${openAIPrompt}`
    );

    if (openAIPrompt.length > MAX_OPEN_AI_QUERY_LENGTH) {
      // noinspection ExceptionCaughtLocallyJS
      throw new Error("OpenAIクエリが大きすぎます");
    }

    const response = await openai.chat.completions.create({
      model: MODEL_NAME,
      messages: [
        { role: "system", content: OPEN_AI_PRIMING },
        { role: "user", content: openAIPrompt }
      ],
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE
    });

    if (response.choices !== undefined && response.choices.length > 0) {
      completion = postprocessSummary(
        diffResponse.data.files.map((file: any) => file.filename),
        response.choices[0].message.content ?? "エラー: 要約を生成できませんでした",
        diffMetadata
      );
    }
  } catch (error) {
    console.error(error);
  }
  return completion;
}

export async function summarizeCommits(
  pullNumber: number,
  repository: { owner: { login: string }; name: string },
  modifiedFilesSummaries: Record<string, string>
): Promise<Array<[ string, string ]>> {
  const commitSummaries: Array<[ string, string ]> = [];

  const pull = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: pullNumber
  });

  const comments = await octokit.paginate(octokit.issues.listComments, {
    owner: repository.owner.login,
    repo: repository.name,
    issue_number: pullNumber
  });

  let commitsSummarized = 0;

  // For each commit, get the list of files that were modified
  const commits = await octokit.paginate(octokit.pulls.listCommits, {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: pullNumber
  });

  const headCommit = pull.data.head.sha;

  let needsToSummarizeHead = false;
  for (const commit of commits) {
    // このコミットに対するコメントが既に存在するか確認
    const expectedComment = `${commit.sha} のGPT要約:`;
    const regex = new RegExp(`^${expectedComment}.*`);
    const existingComment = comments.find((comment: { body?: string }) =>
      regex.test(comment.body ?? "")
    );

    // If a comment already exists, skip this commit
    if (existingComment !== undefined) {
      const currentCommitAbovePrSummary =
        existingComment.body?.split("PR summary so far:")[0] ?? "";
      const summaryLines = currentCommitAbovePrSummary
        .split("\n")
        .slice(1)
        .join("\n");
      commitSummaries.push([ commit.sha, summaryLines ]);
      continue;
    }

    if (commit.sha === headCommit) {
      needsToSummarizeHead = true;
    }

    // Get the commit object with the list of files that were modified
    const commitObject = await octokit.repos.getCommit({
      owner: repository.owner.login,
      repo: repository.name,
      ref: commit.sha
    });

    if (commitObject.data.files === undefined) {
      throw new Error("Files undefined");
    }

    const isMergeCommit = commitObject.data.parents.length !== 1;
    const parent = commitObject.data.parents[0].sha;

    const comparison = await octokit.repos.compareCommits({
      owner: repository.owner.login,
      repo: repository.name,
      base: parent,
      head: commit.sha
    });

    let completion = "エラー: 要約を生成できませんでした";
    if (!isMergeCommit) {
      completion = await getOpenAICompletion(comparison, completion, {
        sha: commit.sha,
        issueNumber: pullNumber,
        repository,
        commit: commitObject
      });
    } else {
      completion = "Not generating summary for merge commits";
    }

    commitSummaries.push([ commit.sha, completion ]);

    // Create a comment on the pull request with the names of the files that were modified in the commit
    const comment = `${commit.sha} のGPT要約:

${completion}`;

    if (commit.sha !== headCommit) {
      await octokit.issues.createComment({
        owner: repository.owner.login,
        repo: repository.name,
        issue_number: pullNumber,
        body: comment,
        commit_id: commit.sha
      });
    }
    commitsSummarized++;
    if (commitsSummarized >= MAX_COMMITS_TO_SUMMARIZE) {
      console.log(
        "Max commits summarized - if you want to summarize more, rerun the action. This is a protection against spamming the PR with comments"
      );
      break;
    }
  }
  const headCommitShaAndSummary = commitSummaries.find(
    ([ sha ]) => sha === headCommit
  );
  if (needsToSummarizeHead && headCommitShaAndSummary !== undefined) {
    let prSummary = "Error summarizing PR";
    try {
      prSummary = await summarizePr(modifiedFilesSummaries, commitSummaries);
    } catch (error) {
      console.error(error);
    }
    const comment = `${headCommit} のGPT要約:

${headCommitShaAndSummary[1]}

PR全体の要約:

${prSummary}`;
    await octokit.issues.createComment({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: pullNumber,
      body: comment,
      commit_id: headCommit
    });
  }
  return commitSummaries;
}
