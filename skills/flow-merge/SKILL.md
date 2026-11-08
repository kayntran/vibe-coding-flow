---
name: flow-merge
description: Gộp nhánh worktree hoặc nhiều làn song song vào nhánh chính — thử xung đột, gom một commit, test đủ bộ, đóng sổ, đẩy lên, dọn. Dùng khi user đã gật trong chat, hoặc nói "gộp đi", "merge", "push lên", "xong rồi đẩy lên". KHÔNG tự gộp khi user chưa đồng ý; KHÔNG dùng để phát hành cho người dùng thật (flow-release, flow-publish).
---

# Flow — gộp

Chỉ chạy khi user đã gật trong chat. Nhánh chính tên `master`/khác ⇒ thay `main` tương ứng.

**Luật gộp riêng của repo thắng.** Đọc `CLAUDE.md`, `AGENTS.md`, tài liệu đóng góp của dự án trước. Repo ghi rõ phải đi qua PR, nhánh
trung gian hoặc bot gộp ⇒ làm theo và dừng đúng ở phần repo giao; không suy đoán điều này từ tên nhánh hay việc thiếu CI.

## Khi nào dừng, khi nào không

| Dừng, hỏi user một câu đời thường | Tự xử lý, không dừng |
|---|---|
| Xung đột mà phải chọn hành vi nào đúng | Xung đột cơ học (thứ tự import, hai bên cùng thêm dòng) |
| Có file lạ không thuộc việc của mình trong commit | Viết nội dung commit |
| Đỏ do việc của mình, đã sửa 2 lần không qua | Đỏ do việc của mình, sửa được trên nhánh |
| Còn lỗi nặng thật chưa được user quyết | File sửa dở của phiên khác ở thư mục chính: không đụng, gộp phần mình |
| Commit lạ sẽ bị đẩy kèm (bước 8) | File trùng tên ở thư mục chính: cất sao lưu rồi gộp tiếp (bước 4) |
| Dữ liệu thật sẽ đổi hoặc mất khi gộp | Đỏ không liên quan, thiếu review/QA/test: báo một dòng, user vẫn muốn gộp thì gộp |

Thiếu bước kiểm không phải lý do đứng lại: test, review, QA là việc AI tự làm; AI ngoài hết lượt thì dùng `code-reviewer` trước, vẫn không làm được thì báo. Không đưa lệnh cho user chép.

## Một nhánh

1. **Thử xung đột trước, chưa đổi gì:** ghim đích MỘT lần `git rev-parse main` (= `<B>`; phiên khác có thể đẩy thêm vào main giữa
   chừng), rồi `git merge-tree --write-tree <B> HEAD`. Thoát 1 ⇒ có xung đột; đọc danh sách file để biết nên xử lý thế nào
   trước khi bắt tay.
2. Trong worktree: `git rebase <B>` (xung đột xử lý trên nhánh) → `git reset --soft <B>` → `git diff --cached --stat <B>` chỉ gồm
   file của việc mình (lạ ⇒ dừng, đừng commit) → `git commit`. **Mỗi việc đúng một commit**, dòng đầu tả việc đó theo quy ước dự án
   + dòng Co-Authored-By. Không tách commit theo loại. Phiên đang cô lập trong worktree: mỗi lệnh git một dòng, không
   `cd "$X" && git …` (harness từ chối).
3. **Test ĐỦ BỘ ngay trong worktree sau rebase** (Agent `test-runner`, chạy qua
   `node ~/.claude/hooks/flow-gate.mjs stamp test -- <lệnh test đủ bộ>`). Gộp là fast-forward nên đây chính là test trên `main`
   sau gộp. Đỏ do việc của mình ⇒ sửa trên nhánh. Đỏ không liên quan, hoặc không chạy được test/review/QA (hết lượt, thiếu công
   cụ) ⇒ báo user một dòng phần chưa kiểm; user vẫn muốn gộp thì gộp, ghi lại để kiểm bù.
   User từng bảo bỏ test hoặc `flow-review` đã ghi lỗi được chấp nhận ⇒ nhắc lại đúng một dòng ở đây.
   Repo là kit (`~/.claude`) ⇒ chạy thêm `node ~/.claude/hooks/mac-check.mjs` (cùng bộ test trên máy macOS Devin — skill
   `flow-devin`, bản đã commit; exit 3 = Devin không dùng được ⇒ báo user một dòng, không chặn gộp).
   Rebase làm diff đổi nội dung (xung đột, main có sửa chạm vùng mình) ⇒ chạy lại `flow-review` (và `flow-qa` nếu đụng UI) cho phần đổi.
4. `ExitWorktree` `action: "keep"` → về thư mục chính, soi lại `git worktree list` + file các phiên khác đang đổi, rồi
   `git merge --ff-only <branch>`. File nằm sẵn ở thư mục chính trùng tên với file của nhánh ⇒ thuộc việc dở của phiên khác thì giữ nguyên và hỏi user; còn lại AI so nội dung, cất sang thư mục
   sao lưu rồi gộp tiếp; không đưa lệnh cho user chép, không sửa kit.
5. **Đóng sổ (sau gộp, trước push):** có `docs/specs/<YYYY-MM-DD>-<slug>/progress.md` ⇒ chạy
   `node ~/.claude/hooks/lib/so-chot.mjs xong <projectRoot> <YYYY-MM-DD>-<slug>` — ghi `Trạng thái: xong` + `Xong ngày` vào
   progress.md (hook thôi nạp sổ này), cất kho các quyết định ✅ phạm vi tính năng (điều `chung` và điều ⚠️ chờ xem lại giữ nguyên) và
   sinh lại INDEX/ROADMAP. Dùng lệnh này, KHÔNG sửa progress.md bằng Edit (lệnh còn cất kho quyết định và sinh lại INDEX/ROADMAP). Việc có chạy
   `flow-impact` ⇒ cập nhật mục tương ứng trong `docs/feature-map.md` (registry · tính năng tiêu thụ · file test đối chiếu). Rồi commit
   phần đóng sổ, kèm `docs/IDEAS.md` nếu có dòng chưa commit (sổ ý tưởng luôn ghi ở thư mục chính, kể cả khi gọi từ worktree, nên
   nhánh không mang nó).
6. **Rút kinh nghiệm (sau gộp, cùng commit đóng sổ):** nhìn lại việc vừa xong — lỗi QA/review, vòng sửa, phát hiện bất ngờ trong PLAN.
   Mỗi điều QUA "durable bar" (đọc code/test/tài liệu hiện có KHÔNG suy ra được, và quên nó sẽ tái phạm) ⇒
   `node ~/.claude/hooks/solutions.mjs ghi <projectRoot> -` (JSON qua stdin); điều tầm thường ⇒ không ghi. Lỗi khớp bài học cũ ⇒
   `solutions.mjs gap <projectRoot> <dang_loi>`; lặp lần 2 mà chưa có máy kiểm ⇒ đề xuất theo thang nó in (luật có sẵn → luật cấm tuỳ
   biến → ast-grep → test → hook → lời dặn) và hỏi user một câu. Báo user MỘT dòng ("ghi 1 bài học: …"). Hằng tháng
   `solutions.mjs ra-soat` — bài học không còn đúng với code thì sửa hoặc bỏ.
7. **Điểm lưu (sau gộp):** `node ~/.claude/hooks/luu.mjs tao <projectRoot> "<việc vừa xong, bằng lời user>" --chi-moc` — chỉ trên máy (tag
   `luu/…`, không đẩy lên mạng); để user nói "quay về lúc …" sau này. Không báo riêng, gộp vào câu báo kết quả. **Luôn `--chi-moc`:** thiếu
   nó, file dở của phiên khác ở thư mục chính bị gom thành commit trên nhánh chính (đã dính 2 lần).
8. **Trước khi push:** `git log --oneline origin/main..main`. Ngoài commit của mình còn commit khác chưa push (của phiên khác/việc cũ) ⇒
   liệt kê cho user, hỏi có push kèm không — push là đẩy tất cả. Rồi `git push origin main` (nếu có remote).
9. **Dọn:** theo mục "Dọn" của skill `flow-worktree` cho đúng worktree vừa gộp.
10. Thứ tự cố định: gộp → `so-chot.mjs xong` → commit → push → dọn worktree. Bị ngắt giữa chừng ⇒ chạy lại từ bước 5: `xong` idempotent,
    không tạo thay đổi trùng (đã `xong` thì không ghi lại, không có thay đổi thì không commit).
11. `merge --ff-only` bị từ chối ⇒ không ép, không stash hộ, không đụng file dở của phiên khác. Main có commit mới ⇒ `EnterWorktree` `path`
    quay lại, làm lại bước 1–10; trùng file dở ⇒ hỏi user.

## Nhiều làn song song

1. Mỗi làn đã qua `lane-check audit` (không có file ngoài scope) — xem skill `flow-team`.
2. Dò xung đột cả bộ một lần: `node ~/.claude/hooks/lane-check.mjs conflicts --base <nhánh-tích-hợp> <làn1> <làn2> …` ⇒ in cặp xung đột +
   **thứ tự gộp gợi ý**. Hai làn xung đột ⇒ gộp nối tiếp, làn sau rebase lên nhánh tích hợp rồi test lại trước khi gộp; không gộp song song.
3. Gộp từng làn vào **nhánh tích hợp** của tính năng (không vào main) theo thứ tự đó, kết hợp thứ tự phụ thuộc (contract → backend →
   frontend → test → docs), chạy test giữa mỗi lần gộp.
4. Trên nhánh tích hợp: test đủ bộ + `flow-qa` các luồng chính + `flow-review` MỘT lần cho cả nhánh.
5. Rồi gộp nhánh tích hợp vào main theo mục "Một nhánh" (gồm bước đóng sổ). Xong: dọn từng worktree làn theo `flow-worktree`
   (hoặc `node ~/.claude/hooks/wt-env.mjs prune`).

## Sau push

CI đỏ ⇒ Agent `debugger` với run id (`gh run view <id> --log-failed`) ⇒ sửa trên nhánh mới theo skill `flow-fix`.
Báo user theo khuôn: đã gộp gì · người dùng thấy gì khác · phần chưa kiểm. Gộp chưa phải phát hành: không trình bày như app đã lên mạng,
và không tự phát hành; muốn lên mạng là việc riêng, phải hỏi.

## Không được

- Xoá worktree/branch không do phiên mình tạo (`locked` = phiên khác đang dùng).
- `git push --force` lên nhánh chính, `git reset --hard` ở thư mục chính.
