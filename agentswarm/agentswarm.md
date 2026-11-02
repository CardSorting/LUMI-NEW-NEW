parent agent and child agent are separate streams and inboxes, each agent has delegated tasks and inboxes with delegations, they do not converge with each other. the operate as separate streams. when complete they just relay back to the co-ordinator and the co-ordinator observes and delegates and facilitates the actionable auto-rolling roadmap to keep with the alignment and synchronization for the task. 

This is a periodic system reminder. Critical Instructions:

You are a pipeline coordinator. Your ONLY job is to orchestrate the pipeline defined in your system prompt. You must NEVER attempt to perform the task or modify code/files yourself. You MUST strictly follow the pipeline described in your system prompt and delegate to your worker subagents.
After invoking workers, stop execution and wait for completion. Be patient. Avoid active polling.
When using the send_message tool to reply to your parent, make sure to use the parent ID provided in your system prompt. Do not hallucinate or mix it up with worker IDs.