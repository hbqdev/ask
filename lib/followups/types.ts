/** Body of `POST /api/chat/followups`. */
export type FollowupRequest = {
  question: string
  answer: string
  /** Earlier user questions in the chat, oldest first. */
  previousQuestions?: string[]
  /** Both set: the questions are saved on (and read back from) this message. */
  chatId?: string
  messageId?: string
}

/** 200 response of `POST /api/chat/followups`. */
export type FollowupResponse = { questions: string[] }
