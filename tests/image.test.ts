/**
 * Image generation (the `imageGen` skill) — parsing and request shape.
 *
 * Verified live 2026-11-02: `ext.input_skill = {"skill_id":"3","skill_type":3}`
 * makes Doubao answer the chat endpoint with a `block_type: 2074` creation block
 * carrying real generated images (Seedream 5.0). These cases pin the shapes that
 * measurement produced.
 */
import { describe, expect, it } from 'vitest'
import {
  DOUBAO_IMAGE_MODEL_ID,
  DOUBAO_SKILLS,
  SKILL_CARRIER_MODEL_ID,
  inputSkillOf,
} from '../src/doubao-catalog.ts'
import { collectBlocks } from '../src/doubao-upstream.ts'

/** A creation block exactly as the stream delivered it (URLs shortened). */
const creationFrame = {
  message_id: '60501607910867970',
  patch_op: [{
    patch_object: 1,
    patch_type: 1,
    patch_value: {
      content_block: [{
        block_type: 2074,
        block_id: '40517519189513474',
        content: {
          creation_block: {
            creations: [{
              type: 1,
              id: '40517519189513730',
              gen_detail: { task_type: 1 },
              can_publish: true,
              image: {
                key: 'tos-cn-i-a9rns2rl98/rc_gen_image/81ecd6038fb64a218e6f46221d1b7ea8.jpeg',
                status: 1,
                placeholder: { width: 2048, height: 2048, description: 'Seedream 5.0 Flash' },
                image_ori: { url: 'https://cdn.invalid/ori.jpeg', width: 2048, height: 2048 },
                image_preview: { url: 'https://cdn.invalid/preview.jpeg', width: 1024, height: 1024 },
                image_thumb: { url: 'https://cdn.invalid/thumb.jpeg', width: 256, height: 256 },
              },
            }],
          },
        },
        is_finish: false,
        patch_type: 2,
      }],
    },
  }],
}

function run(node: unknown) {
  const into = { answer: [] as string[], thinking: [] as string[], images: [] as never[] }
  collectBlocks(node, into, new Set())
  return into
}

describe('inputSkillOf', () => {
  it('encodes the skill as the client does: id is the string of type', () => {
    expect(inputSkillOf('imageGen')).toBe(JSON.stringify({ skill_id: '3', skill_type: 3, variables: {} }))
  })

  it('omits the field for plain chat', () => {
    expect(inputSkillOf(undefined)).toBeUndefined()
    expect(inputSkillOf('freeChat')).toBeUndefined()
  })

  it('keeps the captured numeric ids for the skills this plugin may use', () => {
    expect(DOUBAO_SKILLS.imageGen).toBe(3)
    expect(DOUBAO_SKILLS.codeAssistant).toBe(16)
    expect(DOUBAO_SKILLS.write).toBe(2)
  })
})

describe('parsing a creation block', () => {
  it('extracts the generated image, preferring the original', () => {
    const out = run(creationFrame)
    expect(out.images).toHaveLength(1)
    expect(out.images[0].url).toBe('https://cdn.invalid/ori.jpeg')
    expect(out.images[0].key).toContain('rc_gen_image')
    expect(out.images[0].taskId).toBe('40517519189513730')
    expect(out.images[0].width).toBe(2048)
  })

  it('ignores the placeholder stage (no url yet)', () => {
    const placeholder = JSON.parse(JSON.stringify(creationFrame))
    delete placeholder.patch_op[0].patch_value.content_block[0].content.creation_block.creations[0].image.image_ori
    delete placeholder.patch_op[0].patch_value.content_block[0].content.creation_block.creations[0].image.image_preview
    delete placeholder.patch_op[0].patch_value.content_block[0].content.creation_block.creations[0].image.image_thumb
    expect(run(placeholder).images).toHaveLength(0)
  })

  it('does not mistake a creation block for answer text', () => {
    expect(run(creationFrame).answer).toEqual([])
  })
})

describe('the image model alias', () => {
  it('is not a Doubao model_item_key and rides on the default chat model', () => {
    // The shim maps it; upstream must never see it as a key.
    expect(DOUBAO_IMAGE_MODEL_ID).toBe('image-gen')
    expect(DOUBAO_SKILLS[DOUBAO_IMAGE_MODEL_ID as keyof typeof DOUBAO_SKILLS]).toBeUndefined()
    expect(SKILL_CARRIER_MODEL_ID).toBe('0')
  })
})
