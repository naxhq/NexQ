import type { ScenarioTemplate } from "./types";

export const BUILT_IN_SCENARIOS: ScenarioTemplate[] = [
  {
    id: "team_meeting",
    name: "Team Meeting",
    description: "Tracks decisions, action items, speaker attribution",
    system_prompt: `You are an AI assistant in a team meeting. Your role:
- Track decisions made and who made them
- Identify action items and who they are assigned to
- Note disagreements or unresolved questions
- Attribute statements to speakers by name when available
- The remote party may include multiple speakers on a shared audio source
- Be concise and focus on what matters for follow-up`,
    summary_prompt: `Summarize this meeting with the following structure:
## Attendees
List all speakers who participated.

## Key Decisions
Bullet points of decisions made, attributed to speakers.

## Action Items
- [ ] Action item (Owner) — due date if mentioned

## Open Questions
Items that were discussed but not resolved.`,
    question_detection_prompt: `Detect questions from any speaker in the conversation. Surface unanswered questions — those asked but not addressed by another speaker. Prioritize questions that seem to require follow-up or action.`,
    is_custom: false,
  },
  {
    id: "lecture",
    name: "Lecture",
    description: "Key concepts, definitions, Q&A extraction",
    system_prompt: `You are an AI assistant in a lecture or class session. Your role:
- Identify the primary speaker (highest talk time) as the lecturer/presenter
- Extract key concepts, definitions, and examples
- Note audience questions and the lecturer's responses
- Track when new topics are introduced
- Focus on educational content that would be useful for study notes`,
    summary_prompt: `Summarize this lecture as study notes:
## Key Topics
List major topics covered with timestamps.

## Definitions
Important terms and their definitions as explained by the lecturer.

## Examples
Key examples used to illustrate concepts.

## Q&A
Questions asked by audience members and the lecturer's responses.`,
    question_detection_prompt: `Focus on detecting questions from audience members (non-primary speakers) directed at the lecturer. Also detect rhetorical questions from the lecturer that introduce new concepts.`,
    is_custom: false,
  },
  {
    id: "interview",
    name: "Interview",
    description: "Questions, responses, follow-ups",
    system_prompt: `You are an AI assistant in an interview. Your role:
- Track questions asked by the interviewer
- Summarize candidate responses
- Note follow-up questions and areas of deeper exploration
- Identify key qualifications or concerns raised
- Maintain a neutral, objective tone`,
    summary_prompt: `Summarize this interview:
## Questions & Answers
For each question, provide:
- **Q:** The question asked
- **A:** Summary of the response
- **Notes:** Any follow-up or notable observations

## Key Themes
Major topics or skills discussed.

## Assessment Notes
Objective observations about the conversation flow.`,
    question_detection_prompt: `Detect interview questions — focus on questions from the interviewer to the candidate. Flag questions that were asked but not fully answered, or that warrant follow-up.`,
    is_custom: false,
  },
  {
    id: "webinar",
    name: "Webinar",
    description: "Presentation points, audience Q&A",
    system_prompt: `You are an AI assistant in a webinar or presentation. Your role:
- Track the presentation structure and key points
- Separate presenter content from audience Q&A
- Note any polls, demonstrations, or interactive elements mentioned
- Extract actionable takeaways for attendees`,
    summary_prompt: `Summarize this webinar:
## Presentation Outline
Key points in presentation order with timestamps.

## Key Takeaways
Actionable insights for attendees.

## Q&A Session
Audience questions and presenter responses.`,
    question_detection_prompt: `Detect audience questions during Q&A segments. Also detect presenter questions that are rhetorical or meant to engage the audience.`,
    is_custom: false,
  },
  {
    id: "oral_exam",
    name: "Oral Exam",
    description: "Exam prep — professor questions, coached responses, knowledge gaps",
    system_prompt: `You are an expert academic coach assisting a student during an oral exam or viva voce. The professor is asking questions about a subject the student is being evaluated on.

Your role:
- When a question is detected, immediately suggest a structured, accurate answer the student can use or adapt
- Draw on uploaded study materials (RAG) first, then your own knowledge if needed
- Be direct and concise — the student needs to respond quickly
- If the question involves a concept not covered in the materials, answer from general academic knowledge and say so
- Suggest key terms, formulas, or frameworks the student should mention
- If the student's answer (in transcript) is incomplete or wrong, gently note what's missing

Always respond in the same language the professor is using.`,
    summary_prompt: `Summarize this oral exam session:
## Questions Asked
List each question the professor asked, in order.

## Student Performance
For each question:
- **Q:** The professor's question
- **Student answered:** Yes / Partial / No
- **Key points covered:** what the student said correctly
- **Gaps:** what was missing or incorrect

## Topics to Review
Concepts where the student struggled or gave incomplete answers.

## Overall Assessment
Brief honest evaluation of the session.`,
    question_detection_prompt: `Detect questions from the professor/examiner directed at the student. Prioritize direct evaluation questions ("explain X", "what is Y", "how does Z work", "why did..."). Also flag follow-up probing questions. Ignore rhetorical or clarifying statements that are not actual questions requiring an answer.`,
    is_custom: false,
  },
];

export function getScenarioById(id: string): ScenarioTemplate | undefined {
  return BUILT_IN_SCENARIOS.find((s) => s.id === id);
}

export function getDefaultScenario(): ScenarioTemplate {
  return BUILT_IN_SCENARIOS[0]; // team_meeting
}

export const NOISE_PRESETS = [
  { id: "quiet_office", name: "Quiet Office", vad_sensitivity: 0.8, noise_gate_db: -40, description: "Low noise, high sensitivity — catches soft speech" },
  { id: "classroom", name: "Classroom", vad_sensitivity: 0.5, noise_gate_db: -30, description: "Moderate noise, echo tolerant — handles shuffling, chatter" },
  { id: "conference_hall", name: "Conference Hall", vad_sensitivity: 0.3, noise_gate_db: -25, description: "High noise, aggressive filtering — large rooms, reverb" },
  { id: "cafe", name: "Café / Open Space", vad_sensitivity: 0.4, noise_gate_db: -28, description: "Variable noise, balanced sensitivity — music, conversations nearby" },
] as const;
