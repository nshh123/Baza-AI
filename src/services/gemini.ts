import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';
import {
  getUserMemories,
  storeUserMemory,
  createReminder,
  createTask,
  getUserTasks,
  getRecentConversations,
  saveConversationMessage,
} from './supabase';
import { UserProfile } from '../types';

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
        description: 'The ISO 8601 string timestamp for when to trigger the reminder (e.g. 2026-07-29T19:30:00Z).',
      },
    },
    required: ['message', 'remind_at_iso'],
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
 * Process incoming text or voice message from a user through Gemini 2.0 Flash
 */
export async function processUserMessage(
  user: UserProfile,
  messageText?: string,
  audioBuffer?: Buffer,
  mimeType: string = 'audio/ogg'
): Promise<string> {
  if (!ai) {
    return '⚠️ Gemini API Key is missing. Please set GEMINI_API_KEY in your environment.';
  }

  try {
    // 1. Fetch user memories, recent history, and tasks
    const memories = user.id ? await getUserMemories(user.id) : [];
    const recentHistory = user.id ? await getRecentConversations(user.id, 8) : [];
    const tasks = user.id ? await getUserTasks(user.id) : [];

    const nowISO = new Date().toISOString();
    const memoryContext = memories.map((m) => `- ${m.content}`).join('\n') || 'No previous memories stored.';
    const taskContext = tasks.map((t) => `- ${t.title} [Status: ${t.status}]`).join('\n') || 'No active tasks.';

    const systemInstruction = `You are Baza AI, a friendly, proactive, and highly intelligent WhatsApp Personal Assistant.
Current Date & Time: ${nowISO}.
User Name: ${user.name || 'Friend'}.
User Phone: ${user.phone_number}.

YOUR CAPABILITIES & INSTRUCTIONS:
1. Speak naturally and concisely for WhatsApp. Use emojis, bold *text*, and short bullet points.
2. You can set reminders, store memories/preferences, create tasks, and manage daily plans using your available tools.
3. Automatically store key user details (hobbies, goals, family, preferences) into memory using \`save_memory\` tool without being explicitly asked if it seems useful for long-term helpfulness.
4. When setting reminders, calculate the exact ISO timestamp (\`remind_at_iso\`) based on Current Time (${nowISO}).

USER MEMORIES:
${memoryContext}

ACTIVE TASKS / DAILY PLAN:
${taskContext}`;

    // 2. Build contents array
    const contents: any[] = [];

    // Attach history
    for (const msg of recentHistory) {
      contents.push({
        role: msg.role === 'model' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
    }

    // Attach current message (Audio voice note or Text)
    if (audioBuffer) {
      const base64Audio = audioBuffer.toString('base64');
      contents.push({
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType,
              data: base64Audio,
            },
          },
          {
            text: messageText || 'The user sent a voice note. Listen to the audio, understand their intent, transcribe/answer as needed, and call appropriate tools if requested.',
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
    const response = await ai.models.generateContent({
      model: 'gemini-flash-latest',
      contents,
      config: {
        systemInstruction,
        tools: [
          {
            functionDeclarations: [
              saveMemoryDeclaration,
              createReminderDeclaration,
              addTaskDeclaration,
              getDailyPlanDeclaration,
            ],
          },
        ],
      },
    });

    // 4. Handle Tool / Function Calls
    let finalAnswer = response.text || '';
    const functionCalls = response.functionCalls;

    if (functionCalls && functionCalls.length > 0) {
      for (const call of functionCalls) {
        const { name, args } = call;
        console.log(`🤖 Tool Invoked: ${name}`, args);

        if (name === 'save_memory' && user.id) {
          await storeUserMemory(user.id, (args as any).content, (args as any).category || 'general');
          finalAnswer += `\n\n*(Saved to memory: "${(args as any).content}")*`;
        } else if (name === 'create_reminder' && user.id) {
          await createReminder(user.id, (args as any).message, (args as any).remind_at_iso);
          finalAnswer += `\n\n⏰ *Reminder set for:* ${(args as any).remind_at_iso}`;
        } else if (name === 'add_task' && user.id) {
          await createTask(user.id, (args as any).title, (args as any).description);
          finalAnswer += `\n\n📋 *Added to daily plan:* ${(args as any).title}`;
        } else if (name === 'get_daily_plan' && user.id) {
          const currentTasks = await getUserTasks(user.id);
          const taskListStr = currentTasks.length > 0
            ? currentTasks.map((t, idx) => `${idx + 1}. *${t.title}*`).join('\n')
            : 'Your daily task list is currently empty!';
          finalAnswer += `\n\n📋 *Your Current Daily Plan:*\n${taskListStr}`;
        }
      }
    }

    if (!finalAnswer.trim()) {
      finalAnswer = 'I got your message! How else can I assist you today?';
    }

    if (user.id) {
      await saveConversationMessage(user.id, 'model', finalAnswer);
    }

    return finalAnswer;
  } catch (error: any) {
    console.error('❌ Error processing message with Gemini:', error.message);
    return 'Sorry, I ran into an error processing your request. Please try again!';
  }
}
