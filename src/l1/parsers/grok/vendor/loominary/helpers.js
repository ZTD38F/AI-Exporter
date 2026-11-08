// Adapted subset of Loominary helpers.js; see LICENSE and UPSTREAM.md.
// Preserve source time strings here. The Domain adapter parses epoch timestamps.
export const DateTimeUtils = { formatDateTime: value => value || '' };
export const PARSER_CONFIG = {};
export class MessageBuilder {
  constructor(index, uuid, parentUuid, sender, senderLabel, timestamp) {
    this.message = {
      index,
      uuid,
      parent_uuid: parentUuid || "",
      sender,
      sender_label: senderLabel,
      timestamp,
      content_items: [],
      raw_text: "",
      display_text: "",
      thinking: "",
      tools: [],
      artifacts: [],
      citations: [],
      images: [],
      attachments: [],
      branch_id: null,
      is_branch_point: false,
      branch_level: 0
    };
  }

  build() { return this.message; }
}

// Domain attachmentIds are rendered by the shared composer; no display placeholders.
export const finalizeDisplayText = () => {};
