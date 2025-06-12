import {
  MAX_OPEN_AI_QUERY_LENGTH,
  MAX_TOKENS,
  MODEL_NAME,
  openai,
  TEMPERATURE,
} from "./openAi";

const OPEN_AI_PROMPT = `あなたは優秀なプログラマーであり、プルリクエストの要約を行おうとしています。
このプルリクエストに含まれるすべてのコミット、および変更されたすべてのファイルを確認しました。
一部のコミット要約やファイル差分の要約に誤りが含まれている可能性があります。

このプルリクエストの内容を要約してください。

    箇条書きで出力してください。各項目の先頭には「*」を付けてください。

    高レベルな説明を行ってください。コミット要約やファイル要約の繰り返しは避けてください。

    最も重要なポイントだけを記載してください。箇条書きの数は数項目にとどめてください。

`;

const linkRegex = /\[.*?]\(https:\/\/github\.com\/.*?[a-zA-Z0-f]{40}\/(.*?)\)/;

function preprocessCommitMessage(commitMessage: string): string {
  let match = commitMessage.match(linkRegex);
  while (match !== null) {
    commitMessage = commitMessage.split(match[0]).join(`[${match[1]}]`);
    match = commitMessage.match(linkRegex);
  }
  return commitMessage;
}

export async function summarizePr(
  fileSummaries: Record<string, string>,
  commitSummaries: Array<[string, string]>
): Promise<string> {
  const commitsString = Array.from(commitSummaries.entries())
    .map(
      ([idx, [, summary]]) =>
        `Commit #${idx + 1}:\n${preprocessCommitMessage(summary)}`
    )
    .join("\n");
  const filesString = Object.entries(fileSummaries)
    .map(([filename, summary]) => `File ${filename}:\n${summary}`)
    .join("\n");
  const openAIPrompt = `THE COMMIT SUMMARIES:\n\`\`\`\n${commitsString}\n\`\`\`\n\nTHE FILE SUMMARIES:\n\`\`\`\n${filesString}\n\`\`\`\n\n
  Reminder - write only the most important points. No more than a few bullet points.
  THE PULL REQUEST SUMMARY:\n`;
  console.log(`OpenAI for PR summary prompt:\n${openAIPrompt}`);

  if (openAIPrompt.length > MAX_OPEN_AI_QUERY_LENGTH) {
    return "Error: couldn't generate summary. PR too big";
  }

  try {
    const response = await openai.chat.completions.create({
      model: MODEL_NAME,
      messages: [
        { role: "system", content: OPEN_AI_PROMPT },
        { role: "user", content: openAIPrompt }
      ],
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    });
    return response.choices[0].message.content ?? "Error: couldn't generate summary";
  } catch (error) {
    console.error(error);
    return "Error: couldn't generate summary";
  }
}
