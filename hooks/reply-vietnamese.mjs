// UserPromptSubmit: nhắc Claude mỗi lượt rằng mọi câu trả lời cho user phải bằng tiếng Việt.
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext:
      'BẮT BUỘC: trả lời user bằng TIẾNG VIỆT — cả câu trả lời, báo cáo, câu hỏi AskUserQuestion (question, label, description, preview). ' +
      'Chỉ giữ nguyên tiếng Anh cho code, tên file, lệnh, thuật ngữ kỹ thuật và chữ hiện trên UI của app.',
  },
}))
