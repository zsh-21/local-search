# EXE 用户状态刷新接口学习文档

## 简介
在桌面端 EXE 应用中，用户可能会在 Web 端进行充值或修改资料，此时 EXE 端的本地缓存数据（如 Token 中的信息或本地存储的用户对象）可能已过时。
为了解决此问题，我们新增了 **主动刷新接口** `POST /api/exe/refresh`。EXE 端可以通过调用此接口，获取最新的用户资料及会员状态，并同步更新本地存储。

## 接口说明

**请求地址**
- `POST /api/exe/refresh`

**认证方式**
- Header: `Authorization: Bearer <old_token>`
- 必须携带当前有效的 Token，否则返回 401。

**请求体**
- 无需请求体（空对象 `{}` 即可）。

**响应体**
- 成功时：`{ code: 0, data: { token, user, membership? }, message: "" }`
- 失败时：`{ code: 401, message: "登录已失效" }`

**返回字段详解**
- `token`: **新签发的 Token**（建议替换旧 Token，以延长有效期）。
- `user`: 最新的用户基础信息（昵称、头像、邮箱、手机号等）。
- `membership`: **仅当用户为有效会员时返回**。
  - `expiresAt`: 会员到期时间（ISO 8601 字符串）。

### 示例响应
**有效会员：**
```json
{
  "code": 0,
  "data": {
    "token": "eyJhbGciOiJIUzI1Ni...",
    "user": {
      "id": "65e...",
      "nickname": "Admin",
      "phone": "13800000000",
      "email": "admin@example.com",
      "avatarText": "A",
      "theme": "light",
      "primaryColor": "#1677ff"
    },
    "membership": {
      "expiresAt": "2025-12-31T23:59:59.999Z"
    }
  },
  "message": ""
}
```

**非会员/已过期：**
```json
{
  "code": 0,
  "data": {
    "token": "eyJhbGciOiJIUzI1Ni...",
    "user": {
      "id": "65e...",
      "nickname": "User",
      "phone": "13900000000"
      // ...
    }
    // 不包含 membership 字段
  },
  "message": ""
}
```

## 实现细节
- **路由文件**：[exe.ts](file:///e:/react/file-search-admin/packages/server/src/routes/exe.ts)
- **鉴权中间件**：使用了 `requireAuth`，确保只有登录用户才能调用。
- **数据源**：
  - 优先从 MongoDB (`UserModel`) 查询最新数据。
  - 开发模式下回退到内存存储 (`memoryUsers`)。
- **逻辑**：
  1. 验证 Token 有效性，解析出 `userId`。
  2. 查询数据库中最新的 User 对象。
  3. 重新签发 Token（确保 Token 包含最新状态且重置有效期）。
  4. 判断 `memberExpiresAt` 是否大于当前时间。
  5. 组装返回数据，包含 `user` 和可选的 `membership`。

## 如何使用（EXE 端接入指南）

### 场景 1：用户手动点击“同步状态”
在设置页面或个人中心提供一个“同步/刷新”按钮。

```typescript
// 伪代码示例
async function handleRefreshClick() {
  try {
    const res = await fetch('https://api.example.com/api/exe/refresh', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${localToken}`
      }
    });
    const result = await res.json();
    
    if (result.code === 0) {
      // 1. 更新本地 Token
      saveToken(result.data.token);
      
      // 2. 更新用户信息展示
      updateUserUI(result.data.user);
      
      // 3. 检查会员状态
      if (result.data.membership) {
        unlockPremiumFeatures(result.data.membership.expiresAt);
        showToast('会员状态已同步！');
      } else {
        lockPremiumFeatures();
        showToast('同步成功，当前无有效会员。');
      }
    } else {
      showToast('同步失败：' + result.message);
    }
  } catch (err) {
    console.error(err);
    showToast('网络错误');
  }
}
```

### 场景 2：支付成功后自动刷新
用户在 Web 端完成支付后，EXE 端可以通过轮询或 WebSocket 收到通知，随即调用此接口拉取最新权限。

## 验证方式
1. 启动服务：`pnpm dev:all`
2. 使用 Postman 模拟：
   - 先调用 `/api/exe/login` 获取 Token。
   - 使用该 Token 调用 `POST /api/exe/refresh`。
   - 观察返回的 `token` 是否变化，以及 `membership` 字段是否符合预期（可在数据库手动修改 `memberExpiresAt` 字段进行测试）。
