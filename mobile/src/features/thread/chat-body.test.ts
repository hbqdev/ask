import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import {
  buildChatBody,
  filePartsOf,
  userParts,
  type SearchSettings
} from '@/features/thread/chat-body'

const settings: SearchSettings = {
  searchMode: 'quality',
  sources: ['web', 'academic']
}

const user = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }]
})

const assistant = (id: string, text: string): UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }]
})

describe('buildChatBody', () => {
  it('sends the last message with the search settings on a new chat submit', () => {
    const question = user('u1', 'What is new?')
    const body = buildChatBody({
      trigger: 'submit-message',
      chatId: 'c1',
      messages: [question],
      isNewChat: true,
      settings
    })

    expect(body).toEqual({
      trigger: 'submit-message',
      chatId: 'c1',
      messageId: undefined,
      message: question,
      isNewChat: true,
      searchMode: 'quality',
      sources: ['web', 'academic']
    })
    expect(body).not.toHaveProperty('messages')
    expect(body).not.toHaveProperty('model')
    expect(body).not.toHaveProperty('analyticsId')
  })

  it('is not a new chat once an answer has arrived', () => {
    const body = buildChatBody({
      trigger: 'submit-message',
      chatId: 'c1',
      messages: [user('u1', 'a'), assistant('a1', 'b'), user('u2', 'c')],
      isNewChat: true,
      settings
    })

    expect(body.isNewChat).toBe(false)
    expect(body.message).toEqual(user('u2', 'c'))
  })

  it('is still a new chat when the first question got no answer', () => {
    // The first submit failed before the server could create the chat, so
    // the next submit must still create it (isNewChat=false would 403).
    const body = buildChatBody({
      trigger: 'submit-message',
      chatId: 'c1',
      messages: [user('u1', 'failed'), user('u2', 'again')],
      isNewChat: true,
      settings
    })

    expect(body.isNewChat).toBe(true)
    expect(body.message).toEqual(user('u2', 'again'))
  })

  it('is not a new chat for an existing chat', () => {
    const body = buildChatBody({
      trigger: 'submit-message',
      chatId: 'c1',
      messages: [user('u1', 'a')],
      isNewChat: false,
      settings
    })

    expect(body.isNewChat).toBe(false)
  })

  it('regenerating an assistant message sends its id and no message', () => {
    // The SDK has already cut the conversation before that assistant message.
    const body = buildChatBody({
      trigger: 'regenerate-message',
      chatId: 'c1',
      messageId: 'a1',
      messages: [user('u1', 'a')],
      isNewChat: true,
      settings
    })

    expect(body).toMatchObject({
      trigger: 'regenerate-message',
      messageId: 'a1',
      message: undefined,
      isNewChat: false
    })
  })

  it('regenerating from a user message sends that message', () => {
    const question = user('u1', 'a')
    const body = buildChatBody({
      trigger: 'regenerate-message',
      chatId: 'c1',
      messageId: 'u1',
      messages: [question],
      isNewChat: false,
      settings
    })

    expect(body).toMatchObject({ messageId: 'u1', message: question })
  })

  it('sends the custom instructions when there are some', () => {
    const body = buildChatBody({
      trigger: 'submit-message',
      chatId: 'c1',
      messages: [user('u1', 'a')],
      isNewChat: true,
      settings,
      systemInstructions: 'Use British English.'
    })

    expect(body.systemInstructions).toBe('Use British English.')
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['only whitespace', '  \n ']
  ])('leaves out systemInstructions when they are %s', (_name, value) => {
    const body = buildChatBody({
      trigger: 'submit-message',
      chatId: 'c1',
      messages: [user('u1', 'a')],
      isNewChat: true,
      settings,
      systemInstructions: value
    })

    expect(body).not.toHaveProperty('systemInstructions')
  })
})

const PHOTO = {
  url: 'https://ask.test.invalid/uploads/u1/chats/c1/1-a.jpg?exp=1&sig=s',
  filename: 'a.jpg',
  mediaType: 'image/jpeg'
}
const DOC = {
  url: 'https://ask.test.invalid/uploads/u1/chats/c1/2-b.pdf',
  filename: 'b.pdf',
  mediaType: 'application/pdf'
}

describe('userParts', () => {
  it('is the text, then each file, as the web sends them', () => {
    expect(userParts('About these?', [PHOTO, DOC])).toEqual([
      { type: 'text', text: 'About these?' },
      { type: 'file', ...PHOTO },
      { type: 'file', ...DOC }
    ])
  })

  it('is the text alone without files', () => {
    expect(userParts('Hi')).toEqual([{ type: 'text', text: 'Hi' }])
  })

  it('leaves out an empty text, as the web does for files sent alone', () => {
    expect(userParts('', [DOC])).toEqual([{ type: 'file', ...DOC }])
  })
})

describe('filePartsOf', () => {
  it("gives back the files of a message's parts", () => {
    const message: UIMessage = {
      id: 'u1',
      role: 'user',
      parts: [
        ...userParts('Q', [PHOTO, DOC]),
        { type: 'file', url: 'data:x', mediaType: 'text/plain' }
      ]
    }
    expect(filePartsOf(message)).toEqual([
      PHOTO,
      DOC,
      { url: 'data:x', filename: '', mediaType: 'text/plain' }
    ])
  })
})
