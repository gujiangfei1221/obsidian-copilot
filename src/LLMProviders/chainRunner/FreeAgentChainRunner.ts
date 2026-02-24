import { logInfo } from "@/logger";
import { getSettings } from "@/settings/model";
import { ToolRegistry } from "@/tools/ToolRegistry";
import { initializeBuiltinTools } from "@/tools/builtinTools";
import { StructuredTool } from "@langchain/core/tools";
import { AutonomousAgentChainRunner } from "./AutonomousAgentChainRunner";
import { LLMChainRunner } from "./LLMChainRunner";
import type { ChainRunner } from "./BaseChainRunner";

/**
 * FreeAgentChainRunner: Agent mode for non-Plus users.
 *
 * Extends AutonomousAgentChainRunner to provide the same ReAct + Native Tool Calling
 * experience without requiring a Copilot Plus subscription.
 *
 * Key differences from AutonomousAgentChainRunner:
 * 1. Skips the checkIsPlusUser() license validation (validateAccess() always returns true)
 * 2. Filters out isPlusOnly tools (e.g., youtubeTranscription)
 * 3. Falls back to LLMChainRunner (instead of CopilotPlusChainRunner) on error
 */
export class FreeAgentChainRunner extends AutonomousAgentChainRunner {
  /**
   * Override: Always grant access (no Plus subscription check).
   */
  protected async validateAccess(): Promise<boolean> {
    logInfo("[FreeAgent] Skipping Plus validation - agent mode enabled for free users");
    return true;
  }

  /**
   * Override: Fall back to LLMChainRunner instead of CopilotPlusChainRunner.
   */
  protected createFallbackRunner(): ChainRunner {
    return new LLMChainRunner(this.chainManager);
  }

  /**
   * Override: Filter out Plus-only tools from the available tools list.
   */
  protected getAvailableTools(): StructuredTool[] {
    const settings = getSettings();
    const registry = ToolRegistry.getInstance();

    // Initialize tools if not already done
    if (registry.getAllTools().length === 0) {
      initializeBuiltinTools(this.chainManager.app?.vault);
    }

    // Get enabled tool IDs from settings
    const enabledToolIds = new Set(settings.autonomousAgentEnabledToolIds || []);

    // Get all enabled tools from registry
    const allTools = registry.getEnabledTools(enabledToolIds, !!this.chainManager.app?.vault);

    // Filter out Plus-only tools
    return allTools.filter((tool) => {
      const meta = registry.getToolMetadata(tool.name);
      return !meta?.isPlusOnly;
    });
  }
}
