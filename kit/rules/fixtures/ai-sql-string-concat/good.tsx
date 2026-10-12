// XANH: tham số hoá ($1 + mảng giá trị); template không có biến thì an toàn.
export async function findUser(db: any, id: string) {
  return db.query('SELECT * FROM users WHERE id = $1', [id])
}

export const everyone = (db: any) => db.query(`SELECT * FROM users`)
