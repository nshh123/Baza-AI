import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';
import {
  getUserMemories,
  storeUserMemory,
  createReminder,
  createTask,
  getUserTasks,
  completeTaskByTitle,
  getUserPendingReminders,
  cancelReminderByMessage,
  updateUserTimezone,
  getRecentConversations,
  saveConversationMessage,
} from './supabase';
import { UserProfile } from '../types';
import { isValidTimezone, getLocalTimeString } from '../utils/timezone';
import { formatFriendlyDateTime, formatTaskList, toWhatsAppFormatting } from '../utils/formatting';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// Tool Declarations for Function Calling
const saveMemoryDeclaration: FunctionDeclaration = {
  name: 'save_memory',
  description: 'Save a permanent fact, note, user preference, or personal detail about the user for future memory.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      content: {
        type: Type.STRING,
        description: 'The fact, preference, or detail to store in long-term memory.',
      },
      category: {
        type: Type.STRING,
        description: 'Category such as preference, goal, habit, work, family, or general.',
      },
    },
    required: ['content'],
  },
};

const createReminderDeclaration: FunctionDeclaration = {
  name: 'create_reminder',
  description: 'Schedule a time-based reminder notification to be sent to the user on WhatsApp.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      message: {
        type: Type.STRING,
        description: 'The reminder text/message to send.',
      },
      remind_at_iso: {
        type: Type.STRING,
        description: 'The ISO 8601 UTC timestamp for when to trigger the reminder (e.g. 2026-07-29T19:30:00Z), computed from the user\'s local time.',
      },
      recurrence: {
        type: Type.STRING,
        description: 'Only set this if the user wants the reminder to repeat. Omit entirely for a one-time reminder.',
        enum: ['daily', 'weekly', 'monthly'],
      },
    },
    required: ['message', 'remind_at_iso'],
  },
};

const cancelReminderDeclaration: FunctionDeclaration = {
  name: 'cancel_reminder',
  description: 'Cancel one or more of the user\'s active (not yet sent) reminders that match a description, e.g. the reminder\'s message text.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      message_match: {
        type: Type.STRING,
        description: 'Text to match (case-insensitive substring) against either the reminder\'s message OR its recurrence word ("daily"/"weekly"/"monthly"). E.g. pass "daily" to match a reminder described as repeating daily, even if that word isn\'t in its message. Use wording from the ACTIVE REMINDERS list below.',
      },
    },
    required: ['message_match'],
  },
};

const completeTaskDeclaration: FunctionDeclaration = {
  name: 'complete_task',
  description: 'Mark one or more of the user\'s active tasks as completed, by matching their title.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      title_match: {
        type: Type.STRING,
        description: 'Text to match against the task title (case-insensitive substring). Use wording from the ACTIVE TASKS list below.',
      },
    },
    required: ['title_match'],
  },
};

const setTimezoneDeclaration: FunctionDeclaration = {
  name: 'set_timezone',
  description: 'Update the user\'s stored timezone, e.g. when they mention where they live or correct an assumption. Improves the accuracy of future reminders.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      iana_timezone: {
        type: Type.STRING,
        description: 'A valid IANA timezone name, e.g. "Africa/Kigali", "America/New_York", "Europe/London".',
      },
    },
    required: ['iana_timezone'],
  },
};

const addTaskDeclaration: FunctionDeclaration = {
  name: 'add_task',
  description: 'Add a new task or agenda item to the user\'s daily plan / to-do list.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: {
        type: Type.STRING,
        description: 'Task title.',
      },
      description: {
        type: Type.STRING,
        description: 'Optional additional details about the task.',
      },
      due_date_iso: {
        type: Type.STRING,
        description: 'Optional ISO 8601 UTC timestamp for when the task is due, computed from the user\'s local time the same way reminder times are. Omit if the user didn\'t give a deadline.',
      },
    },
    required: ['title'],
  },
};

const getDailyPlanDeclaration: FunctionDeclaration = {
  name: 'get_daily_plan',
  description: 'Retrieve the user\'s current daily to-do tasks and schedule.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

/**
 * Retry a Gemini call on transient "high demand" (503 UNAVAILABLE) failures with
 * a short backoff. The free-tier API occasionally rejects requests this way under
 * load even when a retry a couple seconds later succeeds fine.
 */
async function generateContentWithRetry(params: Parameters<GoogleGenAI['models']['generateContent']>[0], maxRetries = 2) {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await ai!.models.generateContent(params);
    } catch (error: any) {
      lastError = error;
      const isRetryable = /UNAVAILABLE|"code":\s*503|high demand/i.test(error?.message || '');
      if (!isRetryable || attempt === maxRetries) throw error;

      const delayMs = 1500 * (attempt + 1);
      console.warn(`⚠️ Gemini call failed (attempt ${attempt + 1}/${maxRetries + 1}, likely transient high demand), retrying in ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export interface AssistantReply {
  text: string;
  /** Quick-reply buttons to show after the text (e.g. "View Daily Plan"), if any. */
  buttons?: Array<{ id: string; title: string }>;
}

/**
 * Process incoming text, voice, or image message from a user through Gemini 2.0 Flash
 */
export async function processUserMessage(
  user: UserProfile,
  messageText?: string,
  mediaBuffer?: Buffer,
  mimeType?: string
): Promise<AssistantReply> {
  if (!ai) {
    return { text: '⚠️ Gemini API Key is missing. Please set GEMINI_API_KEY in your environment.' };
  }

  try {
    // 1. Fetch user memories, recent history, tasks, and active reminders (in parallel —
    // these four reads are independent, no reason to pay their latency sequentially)
    const [memories, recentHistory, tasks, pendingReminders] = user.id
      ? await Promise.all([
          getUserMemories(user.id),
          getRecentConversations(user.id, 8),
          getUserTasks(user.id),
          getUserPendingReminders(user.id),
        ])
      : [[], [], [], []];

    const timezone = user.timezone || 'UTC';
    const nowISO = new Date().toISOString();
    const localTimeString = getLocalTimeString(timezone);
    const memoryContext = memories.map((m) => `- ${m.content}`).join('\n') || 'No previous memories stored.';
    const taskContext = tasks.map((t) => `- ${t.title} [Status: ${t.status}]${t.due_date ? ` (due ${t.due_date})` : ''}`).join('\n') || 'No active tasks.';
    const reminderContext = pendingReminders
      .map((r) => `- "${r.message}" at ${r.remind_at}${r.recurrence ? ` (repeats ${r.recurrence})` : ''}`)
      .join('\n') || 'No active reminders.';

    const systemInstruction = `You are Baza AI — a friendly, proactive, highly intelligent personal AI assistant, accessible anytime through WhatsApp.
Current Date & Time (UTC): ${nowISO}.
User's Local Date & Time: ${localTimeString} (timezone: ${timezone}).
User Name: ${user.name || 'Friend'}.
User Phone: ${user.phone_number}.

YOUR CAPABILITIES & INSTRUCTIONS:
1. Speak naturally and concisely for WhatsApp. Use emojis, bold *text*, and short bullet points.
2. You can set/cancel reminders (one-time or recurring), store memories/preferences, create/complete tasks, manage daily plans, and correct the user's timezone using your available tools.
3. Automatically store key user details (hobbies, goals, family, preferences) into memory using \`save_memory\` tool without being explicitly asked if it seems useful for long-term helpfulness.
4. When setting reminders, interpret times the user gives (e.g. "6pm", "tomorrow morning") relative to their Local Date & Time above, then convert to the equivalent UTC ISO timestamp for \`remind_at_iso\`. If the user asks for a repeating reminder ("every day", "weekly", etc.), set \`recurrence\` accordingly. If they give a task a deadline, set \`due_date_iso\` the same way.
5. If the user mentions where they live, or corrects an assumption about their timezone, call \`set_timezone\` with the correct IANA name so future reminders stay accurate.
6. When the user wants to cancel a reminder or complete a task, match it against the lists below and call the matching tool.
7. If sent an image, actively read anything legible in it. If it contains questions, problems, forms, or instructions — answer or solve them directly, even with no caption; don't just describe the image when there's answerable content in it. Only fall back to a plain description if there's genuinely nothing to answer or act on.
8. Never claim you've set a reminder, added/completed a task, saved a memory, or changed a setting unless you actually called the matching tool in this turn — if you're not calling a tool, don't describe having done its action.
9. Whenever you introduce yourself (e.g. asked "who are you" / "what are you"), describe yourself as "your personal AI assistant, accessible anytime through WhatsApp" — keep it warm and concise, not a full capability dump unless asked.

USER MEMORIES:
${memoryContext}

ACTIVE TASKS / DAILY PLAN:
${taskContext}

ACTIVE REMINDERS:
${reminderContext}`;

    // 2. Build contents array
    const contents: any[] = [];

    // Attach history
    for (const msg of recentHistory) {
      contents.push({
        role: msg.role === 'model' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
    }

    // Attach current message (voice note, image, or text)
    if (mediaBuffer && mimeType) {
      const isImage = mimeType.startsWith('image/');
      const base64Media = mediaBuffer.toString('base64');
      const fallbackPrompt = isImage
        ? 'The user sent an image with no caption. If it contains questions, problems, a form, or instructions, read and answer/solve them directly. Otherwise describe what\'s useful about it and offer help.'
        : 'The user sent a voice note. Listen to the audio, understand their intent, transcribe/answer as needed, and call appropriate tools if requested.';
      contents.push({
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType,
              data: base64Media,
            },
          },
          {
            text: messageText || fallbackPrompt,
          },
        ],
      });
    } else if (messageText) {
      contents.push({
        role: 'user',
        parts: [{ text: messageText }],
      });
    }

    if (user.id && messageText) {
      await saveConversationMessage(user.id, 'user', messageText);
    }

    // 3. Call Gemini API
    const response = await generateContentWithRetry({
      model: 'gemini-flash-lite-latest',
      contents,
      config: {
        systemInstruction,
        tools: [
          {
            functionDeclarations: [
              saveMemoryDeclaration,
              createReminderDeclaration,
              cancelReminderDeclaration,
              addTaskDeclaration,
              completeTaskDeclaration,
              getDailyPlanDeclaration,
              setTimezoneDeclaration,
            ],
          },
        ],
      },
    });

    // 4. Handle Tool / Function Calls
    let finalAnswer = response.text || '';
    const functionCalls = response.functionCalls;
    const buttons: Array<{ id: string; title: string }> = [];

    if (functionCalls && functionCalls.length > 0) {
      for (const call of functionCalls) {
        const { name, args } = call;
        console.log(`🤖 Tool Invoked: ${name}`, args);

        if (name === 'save_memory' && user.id) {
          await storeUserMemory(user.id, (args as any).content, (args as any).category || 'general');
          finalAnswer += `\n\n*(Saved to memory: "${(args as any).content}")*`;
        } else if (name === 'create_reminder' && user.id) {
          const recurrence = (args as any).recurrence as 'daily' | 'weekly' | 'monthly' | undefined;
          await createReminder(user.id, (args as any).message, (args as any).remind_at_iso, recurrence);
          const recurrenceNote = recurrence ? ` (repeats ${recurrence})` : '';
          finalAnswer += `\n\n⏰ *Reminder set for:* ${formatFriendlyDateTime((args as any).remind_at_iso, timezone)}${recurrenceNote}`;
          buttons.push({ id: 'view_reminders', title: '⏰ My Reminders' });
        } else if (name === 'cancel_reminder' && user.id) {
          const cancelledCount = await cancelReminderByMessage(user.id, (args as any).message_match);
          finalAnswer += cancelledCount > 0
            ? `\n\n🗑️ *Cancelled ${cancelledCount} reminder(s) matching* "${(args as any).message_match}"`
            : `\n\n⚠️ Couldn't find an active reminder matching "${(args as any).message_match}"`;
        } else if (name === 'add_task' && user.id) {
          await createTask(user.id, (args as any).title, (args as any).description, (args as any).due_date_iso);
          const dueNote = (args as any).due_date_iso ? ` — due ${formatFriendlyDateTime((args as any).due_date_iso, timezone)}` : '';
          finalAnswer += `\n\n📋 *Added to daily plan:* ${(args as any).title}${dueNote}`;
          buttons.push({ id: 'view_tasks', title: '📋 Daily Plan' });
        } else if (name === 'complete_task' && user.id) {
          const completedCount = await completeTaskByTitle(user.id, (args as any).title_match);
          finalAnswer += completedCount > 0
            ? `\n\n✅ *Marked ${completedCount} task(s) complete matching* "${(args as any).title_match}"`
            : `\n\n⚠️ Couldn't find an active task matching "${(args as any).title_match}"`;
        } else if (name === 'get_daily_plan' && user.id) {
          const currentTasks = await getUserTasks(user.id);
          finalAnswer += `\n\n📋 *Your Current Daily Plan:*\n${formatTaskList(currentTasks, timezone)}`;
        } else if (name === 'set_timezone' && user.id) {
          const requestedTz = (args as any).iana_timezone as string;
          if (isValidTimezone(requestedTz)) {
            await updateUserTimezone(user.id, requestedTz);
            finalAnswer += `\n\n🌍 *Timezone updated to:* ${requestedTz}`;
          } else {
            finalAnswer += `\n\n⚠️ "${requestedTz}" doesn't look like a valid timezone name.`;
          }
        }
      }
    }

    if (!finalAnswer.trim()) {
      finalAnswer = 'I got your message! How else can I assist you today?';
    }

    finalAnswer = toWhatsAppFormatting(finalAnswer);

    if (user.id) {
      await saveConversationMessage(user.id, 'model', finalAnswer);
    }

    return { text: finalAnswer, buttons: buttons.length > 0 ? buttons : undefined };
  } catch (error: any) {
    console.error('❌ Error processing message with Gemini:', error.message);
    return { text: 'Sorry, I ran into an error processing your request. Please try again!' };
  }
}
