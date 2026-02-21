class TokenCounter {
  estimate(text) {
    if (!text) return 0;
    // Approximate: 1 token ≈ 4 characters for English, ~2 for CJK
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
    const otherCount = text.length - cjkCount;
    return Math.ceil(otherCount / 4 + cjkCount / 2);
  }

  estimateMessages(messages) {
    let total = 0;
    for (const msg of messages) {
      total += 4; // message overhead
      if (msg.content) total += this.estimate(msg.content);
      if (msg.tool_calls) total += this.estimate(JSON.stringify(msg.tool_calls));
      if (msg.role) total += 1;
    }
    return total;
  }
}

module.exports = { TokenCounter };
