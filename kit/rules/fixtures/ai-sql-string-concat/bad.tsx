// ĐỎ: câu SQL ghép chuỗi / template có biến.
export async function findUser(db: any, id: string) {
  return db.query(`SELECT * FROM users WHERE id = ${id}`)
}

export async function findByName(db: any, name: string) {
  return db.query('SELECT * FROM users WHERE name = ' + name)
}
