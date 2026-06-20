<template>
  <Teleport to="body">
    <div v-if="show" class="modal fixed inset-0 z-50 flex items-center justify-center p-4">
      <!-- 背景遮罩 -->
      <div class="fixed inset-0 bg-gray-900 bg-opacity-50 backdrop-blur-sm" @click="handleClose" />

      <!-- 模态框内容 -->
      <div
        class="modal-content relative mx-auto max-h-[90vh] w-full max-w-2xl overflow-y-auto p-6 sm:p-8"
      >
        <!-- 头部 -->
        <div class="mb-6 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div
              class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600"
            >
              <i class="fas fa-link text-white" />
            </div>
            <div>
              <h3 class="text-xl font-bold text-gray-900 dark:text-gray-100">重新 OAuth 授权</h3>
              <p class="text-sm text-gray-600 dark:text-gray-400">
                为 "{{ account.name || 'Account' }}" 重新完成授权认证
              </p>
            </div>
          </div>
          <button
            class="text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
            @click="handleClose"
          >
            <i class="fas fa-times text-xl" />
          </button>
        </div>

        <!-- 提示：重新授权将覆盖现有 OAuth 令牌 -->
        <div
          class="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-900/30"
        >
          <p class="text-xs text-amber-800 dark:text-amber-300">
            <i class="fas fa-info-circle mr-1" />
            重新授权成功后，将使用新的令牌覆盖当前账户的 OAuth 凭证，账户状态会恢复为正常。
          </p>
        </div>

        <!-- 复用添加账户时的授权认证窗口 -->
        <OAuthFlow
          ref="oauthFlowRef"
          platform="claude"
          :proxy="proxyState"
          @back="handleClose"
          @success="handleOAuthSuccess"
        />
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed } from 'vue'
import OAuthFlow from './OAuthFlow.vue'
import { showToast } from '@/utils/tools'
import { useAccountsStore } from '@/stores/accounts'

const props = defineProps({
  show: {
    type: Boolean,
    required: true
  },
  account: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['close', 'success'])

const accountsStore = useAccountsStore()
const oauthFlowRef = ref(null)
const submitting = ref(false)

// 将账户已保存的代理配置转换为 OAuthFlow 需要的格式
const proxyState = computed(() => {
  const parsed = parseProxy(props.account?.proxy)
  if (parsed && parsed.host && parsed.port) {
    return {
      enabled: true,
      type: parsed.type || 'socks5',
      host: parsed.host,
      port: parsed.port,
      username: parsed.username || '',
      password: parsed.password || ''
    }
  }
  return null
})

const parseProxy = (rawProxy) => {
  if (!rawProxy) return null

  let proxyObject = rawProxy
  if (typeof rawProxy === 'string') {
    try {
      proxyObject = JSON.parse(rawProxy)
    } catch (error) {
      return null
    }
  }

  if (proxyObject && typeof proxyObject === 'object' && proxyObject.proxy) {
    proxyObject = proxyObject.proxy
  }

  if (!proxyObject || typeof proxyObject !== 'object') return null

  const host = proxyObject.host != null ? String(proxyObject.host).trim() : ''
  const port = proxyObject.port != null ? String(proxyObject.port).trim() : ''
  const type =
    typeof proxyObject.type === 'string' && proxyObject.type.trim()
      ? proxyObject.type.trim()
      : 'socks5'
  const username = proxyObject.username != null ? String(proxyObject.username) : ''
  const password = proxyObject.password != null ? String(proxyObject.password) : ''

  return { type, host, port, username, password }
}

const handleClose = () => {
  if (submitting.value) return
  emit('close')
}

// OAuth 授权成功后，使用新令牌更新现有账户
const handleOAuthSuccess = async (tokenInfoOrList) => {
  if (submitting.value) return
  submitting.value = true

  try {
    const tokenInfo = Array.isArray(tokenInfoOrList) ? tokenInfoOrList[0] : tokenInfoOrList
    const claudeOauthPayload = tokenInfo?.claudeAiOauth || tokenInfo

    if (!claudeOauthPayload || !claudeOauthPayload.accessToken) {
      throw new Error('授权返回的令牌无效')
    }

    await accountsStore.updateClaudeAccount(props.account.id, {
      claudeAiOauth: claudeOauthPayload
    })

    showToast('重新授权成功，账户令牌已更新', 'success')
    emit('success')
    emit('close')
  } catch (error) {
    showToast(error.message || '重新授权失败，请重试', 'error')
    // 恢复 OAuthFlow 内部的加载状态（尤其是 Cookie 自动授权模式）
    oauthFlowRef.value?.resetCookieAuth?.()
  } finally {
    submitting.value = false
  }
}
</script>
