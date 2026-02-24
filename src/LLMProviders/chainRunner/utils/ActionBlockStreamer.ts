import { ToolManager } from "@/tools/toolManager";
import { ToolResultFormatter } from "@/tools/ToolResultFormatter";
import { logInfo, logWarn } from "@/logger";

/**
 * ActionBlockStreamer processes streaming chunks to detect and handle writeToFile blocks.
 *
 * 1. Accumulates chunks in a buffer
 * 2. Detects complete writeToFile blocks (including those wrapped in XML code fences)
 * 3. Calls the writeToFile tool when a complete block is found
 * 4. Returns chunks as-is otherwise
 */
export class ActionBlockStreamer {
  private buffer = "";

  constructor(
    private toolManager: typeof ToolManager,
    private writeToFileTool: any
  ) {}

  /**
   * Strip XML/markdown code fences that may wrap writeToFile blocks.
   * Some models (e.g. DeepSeek via SiliconFlow) output ```xml ... ``` wrappers.
   */
  private stripCodeFences(str: string): string {
    // Remove ```xml or ``` wrapping around writeToFile blocks
    return str.replace(
      /```(?:xml)?\s*([\s\S]*?<writeToFile>[\s\S]*?<\/writeToFile>[\s\S]*?)\s*```/g,
      "$1"
    );
  }

  private findCompleteBlock(str: string) {
    // First strip any code fences that wrap the block
    const cleaned = this.stripCodeFences(str);

    // Regex for both formats
    const regex = /<writeToFile>[\s\S]*?<\/writeToFile>/;
    const match = cleaned.match(regex);

    if (!match || match.index === undefined) {
      return null;
    }

    // We need to find the actual end position in the ORIGINAL buffer
    // to correctly trim it after processing
    const writeToFileEnd = str.indexOf("</writeToFile>") + "</writeToFile>".length;
    // Also skip any trailing ``` fence
    const afterBlock = str.substring(writeToFileEnd);
    const fenceMatch = afterBlock.match(/^\s*```/);
    const actualEndIdx = writeToFileEnd + (fenceMatch ? fenceMatch[0].length : 0);

    return {
      block: match[0],
      endIdx: actualEndIdx,
    };
  }

  async *processChunk(chunk: any): AsyncGenerator<any, void, unknown> {
    // Handle different chunk formats
    let chunkContent = "";

    // Handle Claude thinking model array-based content
    if (Array.isArray(chunk.content)) {
      for (const item of chunk.content) {
        if (item.type === "text" && item.text != null) {
          chunkContent += item.text;
        }
      }
    }
    // Handle standard string content
    else if (chunk.content != null) {
      chunkContent = chunk.content;
    }

    // Add to buffer
    if (chunkContent) {
      this.buffer += chunkContent;
    }

    // Yield the original chunk as-is
    yield chunk;

    // Process all complete blocks in the buffer
    let blockInfo = this.findCompleteBlock(this.buffer);

    while (blockInfo) {
      const { block, endIdx } = blockInfo;

      // Extract content from the block
      const pathMatch = block.match(/<path>([\s\S]*?)<\/path>/);
      const contentMatch = block.match(/<content>([\s\S]*?)<\/content>/);
      const filePath = pathMatch ? pathMatch[1].trim() : undefined;
      const fileContent = contentMatch ? contentMatch[1].trim() : undefined;

      logInfo("[ActionBlockStreamer] Detected writeToFile block", {
        path: filePath,
        contentLength: fileContent?.length ?? 0,
      });

      if (!filePath) {
        logWarn("[ActionBlockStreamer] No path found in writeToFile block, skipping");
        this.buffer = this.buffer.substring(endIdx);
        blockInfo = this.findCompleteBlock(this.buffer);
        continue;
      }

      if (!fileContent) {
        logWarn("[ActionBlockStreamer] No content found in writeToFile block", { path: filePath });
      }

      // Call the tool with confirmation=false to bypass preview and directly write
      // This avoids potential issues with ApplyView when creating new files
      try {
        const result = await this.toolManager.callTool(this.writeToFileTool, {
          path: filePath,
          content: fileContent || "",
          confirmation: false,
        });

        // Format tool result using ToolResultFormatter for consistency with agent mode
        const formattedResult = ToolResultFormatter.format("writeToFile", result);
        yield { ...chunk, content: `\n${formattedResult}\n` };
      } catch (err: any) {
        logWarn("[ActionBlockStreamer] writeToFile error", err);
        yield { ...chunk, content: `\nError: ${err?.message || err}\n` };
      }

      // Remove processed block from buffer
      this.buffer = this.buffer.substring(endIdx);

      // Check for another complete block in the remaining buffer
      blockInfo = this.findCompleteBlock(this.buffer);
    }
  }
}
