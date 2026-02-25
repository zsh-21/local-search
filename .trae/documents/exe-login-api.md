## EXE 登录接口学习文档

### 简介
- 目标：为桌面 EXE 提供独立登录接口，但与网站登录保持一致（同一套数据库与账号体系，互通）。
- 结果：新增 `POST /api/exe/login`，复用现有登录校验逻辑（账号解析、密码校验、JWT 颁发、返回 user 信息）。

### 接口说明
**请求地址**
- `POST /api/exe/login`

**请求体**
- `account`: string（手机号/邮箱/昵称均可）
- `password`: string（支持前端 AES 加密后的字符串，也支持明文；后端会做兼容解密）

示例：
```json
{
  "account": "13800138000",
  "password": "your-password-or-encrypted"
}
```

**响应体**
- 成功时：`{ code: 0, data: { token, user }, message: "" }`
- 失败时：`{ code: 401, data: null, message: "账号或密码错误" }`

示例：
```json
{
  "code": 0,
  "data": {
    "token": "BearerTokenHere",
    "user": {
      "id": "xxx",
      "nickname": "xxx",
      "phone": "13800138000",
      "email": "xx@xx.com",
      "avatarText": "nickname-initials",
      "theme": "light/dark",
      "primaryColor": "#hex"
    }
  },
  "message": ""
}
```

### 核心实现逻辑细节

#### 1. 账号解析 (Account Parsing)
服务端会根据 `account` 的格式自动识别用户身份类型：
- **手机号优先**：若 `account` 为 11 位纯数字（正则 `/^\d{11}$/`），优先作为手机号在数据库中查找。
- **邮箱识别**：若非手机号且包含 `@` 符合邮箱格式（正则 `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`），则作为邮箱在数据库中查找（查找时会统一转为小写）。
- **昵称兜底**：若以上均不符合，则作为 `nickname`（昵称）在数据库中查找。

#### 2. 密码解密与校验 (Password Verification)
为了兼容网站前端的加密逻辑，服务端采用以下步骤：
- **AES 解密**：
  - 使用密钥 `file-search-admin-secret-key-2024` 进行解密。
  - 若解密失败（如输入是明文）或解密后为空，服务端会自动回退并使用原始输入的 `password` 字符串。
- **Hash 对比**：
  - 使用 `bcrypt.compare()` 将得到的明文密码与数据库中存储的 `passwordHash` 进行比对，确保安全性。

#### 3. JWT 颁发 (JWT Issuance)
验证通过后，服务端会签发符合标准的 JWT Token：
- **Payload 载荷**：仅包含 `{ sub: userId }`，其中 `sub` 是用户的唯一 ID。
- **签名算法**：使用服务端配置的 `JWT_SECRET` 进行 HS256 签名。
- **有效期**：根据配置决定（通常为 7d 或更长，适合桌面端持久登录）。

#### 4. 用户信息返回 (User Info)
返回的 `user` 对象包含以下核心字段，方便 EXE 端展示：
- `id`: 用户唯一标识
- `nickname`: 用户昵称
- `phone`: 手机号
- `email`: 邮箱地址
- `avatarText`: 头像文字标识（通常是昵称首字母）
- `theme`: 用户偏好的主题色模式
- `primaryColor`: 用户自定义的主题色

### 如何使用（EXE 端）
1. **登录请求**：
   - `POST {API_BASE_URL}/api/exe/login`
2. **凭证存储**：
   - 收到 `token` 后，EXE 端应安全存储该字符串（如 Keychain、加密存储）。
3. **接口调用**：
   - 在后续需要身份验证的接口中，在 HTTP Header 中添加：
     `Authorization: Bearer <token>`

### 验证方式
- 使用 Postman/Apifox/curl 调用测试：
  - 测试手机号登录：`{"account": "138...", "password": "..."}`
  - 测试邮箱登录：`{"account": "test@abc.com", "password": "..."}`
  - 测试错误密码：预期返回 `code: 401`

### 参考代码
- 路由实现：[exe.ts](file:///e:/react/file-search-admin/packages/server/src/routes/exe.ts)
- 密码解密：[crypto.ts](file:///e:/react/file-search-admin/packages/server/src/utils/crypto.ts)
- JWT 签发：[jwt.ts](file:///e:/react/file-search-admin/packages/server/src/auth/jwt.ts)
- 路由挂载：[app.ts](file:///e:/react/file-search-admin/packages/server/src/app.ts)
