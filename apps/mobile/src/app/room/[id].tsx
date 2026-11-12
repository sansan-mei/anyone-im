import { View, Text, TextInput, TouchableOpacity, SafeAreaView, StyleSheet, FlatList, KeyboardAvoidingView, Platform, Alert } from 'react-native'
import { useState, useEffect, useRef } from 'react'
import { useLocalSearchParams, router } from 'expo-router'
import { io, type Socket } from 'socket.io-client'
import type { ServerToClientEvents, ClientToServerEvents, Message, User } from '@anyone-im/contracts'

const API_BASE = 'http://127.0.0.1:4100'

export default function Room() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const [messages, setMessages] = useState<Message[]>([])
  const [inputText, setInputText] = useState('')
  const [socket, setSocket] = useState<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null)
  const [roomName, setRoomName] = useState('')
  const flatListRef = useRef<FlatList>(null)

  useEffect(() => {
    if (!id) return
    
    const init = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/rooms/${encodeURIComponent(id)}`, { credentials: 'include' })
        const data = await res.json()
        if ('error' in data) {
          Alert.alert('错误', data.error.message)
          router.back()
          return
        }
        setRoomName(data.data.name)
        
        const socketInstance = io(API_BASE, {
          transports: ['websocket', 'polling'],
          withCredentials: true,
          reconnectionDelay: 800,
          reconnectionDelayMax: 8000
        })
        
        socketInstance.on('connect', () => {
          socketInstance.emit('room:subscribe', { roomId: id }, (err, result) => {
            if (err || 'error' in result) {
              console.error('Subscribe error:', err || result.error)
              return
            }
            setMessages(result.data.messages)
          })
        })
        
        socketInstance.on('message:new', (message: Message) => {
          if (message.roomId === id) {
            setMessages(prev => [...prev, message])
          }
        })
        
        socketInstance.on('message:deleted', (event) => {
          if (event.roomId === id) {
            setMessages(prev => prev.filter(m => m.id !== event.messageId))
          }
        })
        
        setSocket(socketInstance)
      } catch (e) {
        Alert.alert('错误', '加载房间失败')
      }
    }
    
    init()
    
    return () => {
      socket?.disconnect()
    }
  }, [id])

  const sendMessage = async () => {
    if (!inputText.trim() || !socket) return
    
    const clientMessageId = crypto.randomUUID()
    
    socket.emit('message:send', {
      roomId: id!,
      clientMessageId,
      text: inputText.trim()
    }, (result) => {
      if ('error' in result) {
        Alert.alert('发送失败', result.error.message)
      }
    })
    
    setInputText('')
  }

  const renderItem = ({ item }: { item: Message }) => (
    <View style={[styles.messageItem, !item.deletedAt && styles.messageActive]}>
      <Text style={styles.senderName}>{item.sender.displayName}</Text>
      {item.deletedAt ? (
        <Text style={styles.deletedMessage}>消息已删除</Text>
      ) : (
        <>
          {item.text ? <Text style={styles.messageText}>{item.text}</Text> : null}
          {item.attachment && (
            <Text style={styles.attachmentText}>📎 图片附件</Text>
          )}
          <Text style={styles.messageTime}>
            {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </>
      )}
    </View>
  )

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Text style={styles.backButtonText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{roomName || '聊天室'}</Text>
        <View style={{ width: 40 }} />
      </View>
      
      <FlatList
        ref={flatListRef}
        data={messages}
        renderItem={renderItem}
        keyExtractor={item => item.id}
        style={styles.messageList}
        contentContainerStyle={styles.messageListContent}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>暂无消息</Text>
          </View>
        }
      />
      
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            value={inputText}
            onChangeText={setInputText}
            placeholder="输入消息..."
            multiline
            maxLength={4000}
          />
          <TouchableOpacity
            style={[styles.sendButton, !inputText.trim() && styles.sendButtonDisabled]}
            onPress={sendMessage}
            disabled={!inputText.trim()}
          >
            <Text style={styles.sendButtonText}>发送</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0'
  },
  backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  backButtonText: { fontSize: 24, color: '#1a73e8' },
  headerTitle: { fontSize: 18, fontWeight: '600' },
  messageList: { flex: 1 },
  messageListContent: { padding: 12 },
  messageItem: {
    marginBottom: 12,
    padding: 12,
    borderRadius: 12,
    maxWidth: '80%'
  },
  messageActive: { backgroundColor: '#fff', alignSelf: 'flex-start' },
  senderName: { fontSize: 12, color: '#666', marginBottom: 4 },
  messageText: { fontSize: 15, color: '#333' },
  attachmentText: { fontSize: 14, color: '#1a73e8', marginTop: 4 },
  messageTime: { fontSize: 11, color: '#999', marginTop: 4, alignSelf: 'flex-end' },
  deletedMessage: { fontSize: 14, color: '#999', fontStyle: 'italic' },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 60 },
  emptyText: { color: '#999', fontSize: 14 },
  inputContainer: {
    flexDirection: 'row',
    padding: 12,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0'
  },
  input: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    maxHeight: 100,
    marginRight: 8
  },
  sendButton: {
    backgroundColor: '#1a73e8',
    paddingHorizontal: 20,
    borderRadius: 20,
    justifyContent: 'center'
  },
  sendButtonDisabled: { backgroundColor: '#ccc' },
  sendButtonText: { color: '#fff', fontWeight: '600' }
})
