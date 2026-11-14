/** Body of `POST /api/chat/followups`. */
export type FollowupRequest = {
  question: string
  answer: string
  /** Earlier user questions in the chat, oldest first. */
  previousQuestions?: string[]
  /**
   * The message the questions are saved on (and read back from). The
   * endpoint requires both (400 otherwise); a request built without a chat
   * id simply gets no questions.
   */
  chatId?: string
  messageId?: string
}

/** 200 response of `POST /api/chat/followups`. */
export type FollowupResponse = { questions: string[] }
